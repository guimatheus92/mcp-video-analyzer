import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ZodError } from 'zod';
import { registerAllAdapters } from './adapters/register.js';
import {
  AnalyzeOptionsSchema,
  assembleResultDoc,
  getAnalysis,
  resolveAnalyzeParams,
} from './tools/analyze-core.js';
import type { AnalyzeOptions, ProgressReporter } from './tools/analyze-core.js';
import type { IFrameResult } from './types.js';
import { persistentCacheDir } from './utils/temp-files.js';
import { isVideoSource } from './utils/url-detector.js';

const CLI_USAGE = `Usage: mcp-video-analyzer analyze <url-or-path> [options]

One-shot video analysis. Prints a single JSON document to stdout (progress and
errors go to stderr). Frame images are copied to --out and referenced by
absolute path in the JSON. Partial failures degrade into the "warnings" array
(exit 0); only a hard failure exits 1.

Options:
  --detail <level>        brief | standard | detailed (default: standard)
  --max-frames <n>        Max key frames to extract (1-60; default adapts to duration)
  --fields <list>         Output filter — comma-separated subset of: metadata,
                          transcript,frames,comments,chapters,ocrResults,
                          timeline,aiSummary. Filters the emitted JSON only;
                          use --detail brief to actually skip frame extraction.
  --force-refresh         Bypass cache and re-analyze
  --ocr-language <codes>  Tesseract OCR languages (default: eng+por)
  --model <name>          Whisper model override (e.g. small, medium)
  --language <code>       Forced transcription language (e.g. pt)
  --out <dir>             Where to copy frame images
                          (default: <tmp>/mcp-video-analyzer/<url-hash>)
  -h, --help              Show this help

Sources: Loom, YouTube, Vimeo, TikTok, Instagram, X/Twitter, Twitch,
Dailymotion, Facebook (yt-dlp required), direct .mp4/.webm/.mov URLs, and
local paths / file:// URIs.
`;

export interface CliInvocation {
  url: string | undefined;
  options: AnalyzeOptions;
  outDir: string | undefined;
  help: boolean;
}

/** Parse `analyze` argv. Throws on unknown flags (parseArgs) or invalid option values (zod). */
export function parseCliArgs(argv: string[]): CliInvocation {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      detail: { type: 'string' },
      'max-frames': { type: 'string' },
      fields: { type: 'string' },
      'force-refresh': { type: 'boolean' },
      'ocr-language': { type: 'string' },
      model: { type: 'string' },
      language: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const raw: Record<string, unknown> = {};
  if (values.detail !== undefined) raw.detail = values.detail;
  if (values['max-frames'] !== undefined) raw.maxFrames = Number(values['max-frames']);
  if (values.fields !== undefined) {
    raw.fields = values.fields
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);
  }
  if (values['force-refresh']) raw.forceRefresh = true;
  if (values['ocr-language'] !== undefined) raw.ocrLanguage = values['ocr-language'];
  if (values.model !== undefined) raw.model = values.model;
  if (values.language !== undefined) raw.language = values.language;

  // Validation (enum/range) comes from the shared MCP tool schema.
  const options = AnalyzeOptionsSchema.parse(Object.keys(raw).length > 0 ? raw : undefined);

  return {
    url: positionals[0],
    options,
    outDir: values.out,
    help: values.help ?? false,
  };
}

/** Stable per-source frames dir so repeat runs reuse the same folder. */
export function defaultOutDir(url: string): string {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 12);
  return persistentCacheDir(hash);
}

/**
 * Copy frame images out of the per-call temp dir (about to be cleaned up) into
 * `outDir`, rewriting each `filePath`. Keeps the temp basenames — never derive
 * names from `time` values, which contain `:` (illegal on Windows).
 *
 * ENOENT on the source (frame already cleaned up after a cache hit) is the
 * benign case, counted in `missing`. Any other failure (EACCES/ENOSPC/EROFS on
 * the destination) is a real write problem — reported per-frame in `errors`
 * with the actual errno message, never disguised as a cache race.
 */
export async function copyFrames(
  frames: IFrameResult[],
  outDir: string,
): Promise<{ frames: IFrameResult[]; missing: number; errors: string[] }> {
  await mkdir(outDir, { recursive: true });
  const copied: IFrameResult[] = [];
  let missing = 0;
  const errors: string[] = [];
  for (const frame of frames) {
    const dest = join(outDir, basename(frame.filePath));
    try {
      await copyFile(frame.filePath, dest);
      copied.push({ ...frame, filePath: dest });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        missing++;
      } else {
        errors.push(
          `Frame copy to ${dest} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return { frames: copied, missing, errors };
}

function formatError(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues
      .map((issue) => `Invalid option "${String(issue.path[0] ?? '')}": ${issue.message}`)
      .join('\n');
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * `mcp-video-analyzer analyze` entry point. stdout is reserved for the single
 * JSON result document — everything else (progress, errors) goes to stderr.
 */
export async function runCli(argv: string[]): Promise<number> {
  let invocation: CliInvocation;
  try {
    invocation = parseCliArgs(argv);
  } catch (err) {
    process.stderr.write(`${formatError(err)}\n\n${CLI_USAGE}`);
    return 1;
  }

  if (invocation.help) {
    process.stdout.write(CLI_USAGE);
    return 0;
  }

  // A CLI runs from a known shell cwd, so resolve relative local paths before
  // the gate (the MCP server rejects them — its cwd is unpredictable).
  let url = invocation.url;
  if (url && !isAbsolute(url) && !url.includes('://') && existsSync(url)) {
    url = resolve(url);
  }
  if (!url || !isVideoSource(url)) {
    process.stderr.write(
      'Must be a supported video URL (Loom, YouTube, Vimeo, TikTok, Instagram, X/Twitter, Twitch, Dailymotion, Facebook), a direct .mp4/.webm/.mov URL, or a path / file:// URI to a local video file\n',
    );
    return 1;
  }

  registerAllAdapters();

  const progress: ProgressReporter = async (percent, message) => {
    process.stderr.write(`[${Math.round(percent)}%] ${message ?? ''}\n`);
  };

  let handle;
  try {
    handle = await getAnalysis(url, resolveAnalyzeParams(invocation.options), progress);
  } catch (err) {
    process.stderr.write(`${formatError(err)}\n`);
    return 1;
  }

  const { result } = handle;
  const fields = invocation.options?.fields;
  const wantFrames = !fields || fields.includes('frames');

  let frames: IFrameResult[] = [];
  let missing = 0;
  const copyWarnings: string[] = [];
  try {
    if (wantFrames && result.frames.length > 0) {
      const copied = await copyFrames(result.frames, invocation.outDir ?? defaultOutDir(url));
      frames = copied.frames;
      missing = copied.missing;
      copyWarnings.push(...copied.errors);
    }
  } catch (err) {
    // A failed mkdir/copy (bad --out, permissions) must not discard an
    // analysis that already succeeded — degrade into warnings[] and emit the
    // document without frame files (graceful-degradation convention).
    copyWarnings.push(
      `Frame images could not be copied to the output dir: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    // Always reclaim the per-call temp dir, even when the copy failed.
    await handle.cleanup();
  }

  const doc = assembleResultDoc(result, fields, {
    missingFrames: missing,
    refreshHint: '--force-refresh',
    extraWarnings: copyWarnings,
  });
  if (wantFrames) doc.frames = frames;

  process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
  return 0;
}
