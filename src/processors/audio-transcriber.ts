import { execFile as execFileCb } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, delimiter, dirname, extname, join } from 'node:path';
import { promisify } from 'node:util';
import type { ITranscriptEntry } from '../types.js';
import { envFlag } from '../utils/env.js';
import { formatTimestamp } from './frame-extractor.js';

const execFile = promisify(execFileCb);

const require = createRequire(import.meta.url);
const ffmpegPath: string = require('ffmpeg-static') as string;

/**
 * Extract the audio track from a video file as a 16kHz mono WAV.
 * This is the format expected by most speech recognition engines.
 */
export async function extractAudioTrack(videoPath: string, outputDir: string): Promise<string> {
  const outputPath = join(outputDir, 'audio.wav');

  try {
    await execFile(
      ffmpegPath,
      [
        '-i',
        videoPath,
        '-vn',
        '-acodec',
        'pcm_s16le',
        '-ar',
        '16000',
        '-ac',
        '1',
        outputPath,
        '-y',
      ],
      { timeout: 120000 },
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Audio extraction failed: ${msg}`, { cause: error });
  }

  return outputPath;
}

/**
 * Per-call transcription overrides. Each field takes precedence over the
 * corresponding environment variable, letting callers pick a heavier model or a
 * domain glossary for one hard clip without restarting the server. Unset fields
 * fall back to the env defaults.
 */
export interface TranscribeOptions {
  /** Whisper model name, e.g. `small`, `medium` (overrides WHISPER_MODEL). */
  model?: string;
  /** Forced language code, e.g. `pt` (overrides WHISPER_LANGUAGE). */
  language?: string;
  /** Domain glossary fed as `--initial_prompt` (overrides WHISPER_PROMPT). */
  initialPrompt?: string;
}

/**
 * Mean-volume floor (dBFS): tracks at or below this are treated as silent
 * (muted screen recordings, silent Reels/Stories) and skip Whisper entirely,
 * so an empty transcript reads as content instead of a transcription failure.
 */
// ponytail: -55dB mean over the first 2 minutes; add an env knob if a real voice track ever trips it.
const SILENCE_MEAN_DB = -55;

/**
 * Parse `mean_volume: -XX.X dB` from ffmpeg volumedetect stderr.
 * Exported for testing. Returns null when no reading is present.
 */
export function parseMeanVolume(stderr: string): number | null {
  const match = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(stderr);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

async function detectMeanVolume(audioPath: string): Promise<number | null> {
  try {
    const { stderr } = await execFile(
      ffmpegPath,
      ['-hide_banner', '-t', '120', '-i', audioPath, '-af', 'volumedetect', '-f', 'null', '-'],
      { timeout: 30000 },
    );
    return parseMeanVolume(stderr);
  } catch {
    return null; // probe failure never blocks transcription
  }
}

/**
 * Transcribe an audio file using the best available strategy.
 *
 * A silence gate runs first: a present-but-mute track (common in Reels/Stories)
 * skips every strategy with a warning, so no Whisper time is burned producing [].
 *
 * Strategy chain (graceful fallback):
 * 1. @huggingface/transformers — **opt-in only**: runs solely when
 *    WHISPER_HF_MODEL is set (otherwise it would silently transcribe with an
 *    English `tiny` model, ignoring WHISPER_MODEL/WHISPER_LANGUAGE).
 * 2. whisper CLI (requires Python + whisper installed; model via WHISPER_MODEL,
 *    language via WHISPER_LANGUAGE, glossary via WHISPER_PROMPT, optional
 *    GPU/quality flags for whisper-ctranslate2 — see buildWhisperCliArgs).
 * 3. OpenAI Whisper API (requires OPENAI_API_KEY env var)
 * 4. Returns [] if nothing is available
 */
export async function transcribeAudio(
  audioPath: string,
  opts: TranscribeOptions = {},
  onWarning?: (message: string) => void,
): Promise<ITranscriptEntry[]> {
  const meanDb = await detectMeanVolume(audioPath);
  if (meanDb !== null && meanDb <= SILENCE_MEAN_DB) {
    onWarning?.(
      `Audio track is silent (mean volume ${meanDb}dB) — empty transcript is expected content, not an error.`,
    );
    return [];
  }

  // Strategy 1: @huggingface/transformers (JS-native whisper) — opt-in
  const hfResult = await transcribeWithHuggingFace(audioPath, opts);
  if (hfResult) return hfResult;

  // Strategy 2: whisper CLI
  const cli = await transcribeWithWhisperCli(audioPath, opts, onWarning);
  if (cli.status === 'ok') return cli.entries;

  // Strategy 3: OpenAI Whisper API
  const apiResult = await transcribeWithOpenAiApi(audioPath, opts, onWarning);
  if (apiResult) return apiResult;

  // Nothing produced a transcript. When no backend is even configured (the
  // common cause of a mysteriously empty transcript), say how to enable one
  // instead of returning a bare [] the caller reports as "no transcript".
  if (
    !process.env.WHISPER_HF_MODEL &&
    cli.status === 'not-installed' &&
    !process.env.OPENAI_API_KEY
  ) {
    onWarning?.(
      'No speech-to-text backend available. Install the Whisper CLI (pip install -U openai-whisper), set OPENAI_API_KEY, or set WHISPER_HF_MODEL to transcribe audio.',
    );
  }
  return [];
}

async function transcribeWithHuggingFace(
  audioPath: string,
  opts: TranscribeOptions,
): Promise<ITranscriptEntry[] | null> {
  // Opt-in: without an explicit HF model the CLI (which honors WHISPER_MODEL /
  // WHISPER_LANGUAGE) should win, so we don't silently fall back to tiny/English.
  const hfModel = process.env.WHISPER_HF_MODEL;
  if (!hfModel) return null;

  const transformers = await loadTransformers();
  if (!transformers) return null;

  try {
    const { pipeline } = transformers;
    const transcriber = await pipeline('automatic-speech-recognition', hfModel, {
      return_timestamps: true,
    });

    const language = opts.language || process.env.WHISPER_LANGUAGE;
    const result = await transcriber(audioPath, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
      ...(language ? { language, task: 'transcribe' } : {}),
    });

    if (!result || typeof result !== 'object') return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chunks = (result as any).chunks ?? [];
    if (!Array.isArray(chunks) || chunks.length === 0) {
      // Might be a simple text result
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const text = (result as any).text;
      if (typeof text === 'string' && text.trim().length > 0) {
        return [{ time: '0:00', text: text.trim() }];
      }
      return null;
    }

    return (
      chunks
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((chunk: any) => typeof chunk.text === 'string' && chunk.text.trim().length > 0)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((chunk: any) => ({
          time: formatTimestamp(Math.round(chunk.timestamp?.[0] ?? 0)),
          text: chunk.text.trim(),
        }))
    );
  } catch {
    return null;
  }
}

/**
 * Build the argument list for the `whisper` CLI.
 *
 * Precedence: per-call `opts` → environment variable → built-in default.
 * Model defaults to `tiny` but can be overridden with WHISPER_MODEL (e.g. `small`,
 * `medium` for much better non-English accuracy). WHISPER_LANGUAGE forces a language
 * (e.g. `pt`) instead of relying on auto-detection. WHISPER_PROMPT supplies a domain
 * glossary (`--initial_prompt`) that fixes proper nouns (brand/place names).
 *
 * GPU/quality flags are **env-gated** so they're only emitted when explicitly
 * requested: `openai-whisper` rejects flags it doesn't know (notably
 * `--compute_type`), while the drop-in `whisper-ctranslate2` / `faster-whisper`
 * CLI accepts the full set. `--device`, `--beam_size`, and `--word_timestamps`
 * are understood by both backends; only `--compute_type` is ctranslate2-specific.
 */
export function buildWhisperCliArgs(
  audioPath: string,
  outputDir: string,
  opts: TranscribeOptions = {},
): string[] {
  const model = opts.model || process.env.WHISPER_MODEL || 'tiny';
  const args = [audioPath, '--output_format', 'json', '--model', model, '--output_dir', outputDir];

  const language = opts.language || process.env.WHISPER_LANGUAGE;
  if (language) {
    args.push('--language', language);
  }

  // `||` (not `??`) so an empty-string override falls through to the env value
  // rather than passing an empty `--initial_prompt`, matching model/language.
  const prompt = opts.initialPrompt || process.env.WHISPER_PROMPT;
  if (prompt) {
    args.push('--initial_prompt', prompt);
  }

  const device = process.env.WHISPER_DEVICE; // 'cuda' | 'cpu'
  if (device) {
    args.push('--device', device);
  }

  const compute = process.env.WHISPER_COMPUTE; // ctranslate2 only: 'float16' | 'int8_float16' | 'int8'
  if (compute) {
    args.push('--compute_type', compute);
  }

  const beamSize = process.env.WHISPER_BEAM_SIZE;
  if (beamSize) {
    args.push('--beam_size', beamSize);
  }

  if (envFlag(process.env.WHISPER_WORD_TIMESTAMPS)) {
    args.push('--word_timestamps', 'True');
  }

  return args;
}

/**
 * Parse the JSON Whisper writes with `--output_format json` into transcript
 * entries. Exported for testing. Returns null when there are no usable segments.
 */
export function parseWhisperJson(raw: string): ITranscriptEntry[] | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (!Array.isArray(parsed['segments'])) return null;

  return (parsed['segments'] as Record<string, unknown>[])
    .filter((seg) => typeof seg['text'] === 'string' && (seg['text'] as string).trim().length > 0)
    .map((seg) => ({
      time: formatTimestamp(Math.round((seg['start'] as number) ?? 0)),
      text: (seg['text'] as string).trim(),
    }));
}

/**
 * Outcome of the whisper CLI strategy. `not-installed` (no binary on any
 * candidate) is distinct from `failed` (found but crashed/produced no usable
 * output) so the caller can emit an install hint only when nothing is present.
 */
type WhisperCliOutcome =
  | { status: 'ok'; entries: ITranscriptEntry[] }
  | { status: 'not-installed' }
  | { status: 'failed' };

async function transcribeWithWhisperCli(
  audioPath: string,
  opts: TranscribeOptions,
  onWarning?: (message: string) => void,
): Promise<WhisperCliOutcome> {
  // WHISPER_BIN can point at an explicit path (on Windows the Python Scripts
  // dir is often off the PATH that GUI-launched MCP clients inherit); otherwise
  // fall back to `whisper` on PATH. We run the real command and read ENOENT to
  // tell "not installed" from "installed but broken" — no separate `--help`
  // probe (it double-imports torch, ~15s, and crashes on Windows when the help
  // text contains non-ASCII under the cp1252 stdout codec).
  const candidates = [process.env.WHISPER_BIN, 'whisper'].filter(
    (c): c is string => typeof c === 'string' && c.length > 0,
  );

  // Write output into the audio's own dir (a per-video temp dir) rather than a
  // shared tmpdir(), so concurrent transcriptions don't collide on the same
  // `<base>.json` (every audio track is named `audio.wav`).
  const outputDir = dirname(audioPath);
  const jsonPath = join(outputDir, `${basename(audioPath, extname(audioPath))}.json`);

  const env = {
    ...process.env,
    // whisper (Python) shells out to `ffmpeg` to decode audio. Put the bundled
    // ffmpeg-static binary on PATH so no system ffmpeg install is required.
    PATH: `${dirname(ffmpegPath)}${delimiter}${process.env.PATH ?? ''}`,
    // Python's stdout defaults to the locale codec (cp1252 on Windows), which
    // throws UnicodeEncodeError when Whisper prints non-ASCII text (CJK,
    // accented Portuguese, …). Force UTF-8 both ways so multilingual audio
    // doesn't crash the CLI mid-transcription.
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  };

  for (const cmd of candidates) {
    try {
      await execFile(cmd, buildWhisperCliArgs(audioPath, outputDir, opts), {
        timeout: 300000,
        env,
      });
    } catch (e: unknown) {
      // Command not found (or WHISPER_BIN path wrong) → try the next candidate;
      // if none resolve, the caller reports "no backend installed".
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      // Found but crashed/timed out — surface it (fixable, unlike not-installed).
      onWarning?.(`Whisper CLI failed: ${e instanceof Error ? e.message : String(e)}`);
      await rm(jsonPath, { force: true }).catch(() => undefined);
      return { status: 'failed' };
    }

    try {
      const entries = parseWhisperJson(await readFile(jsonPath, 'utf-8'));
      // null = no `segments` key (unexpected output) → let OpenAI try next.
      return entries === null ? { status: 'failed' } : { status: 'ok', entries };
    } catch {
      return { status: 'failed' };
    } finally {
      await rm(jsonPath, { force: true }).catch(() => undefined);
    }
  }

  return { status: 'not-installed' };
}

async function transcribeWithOpenAiApi(
  audioPath: string,
  opts: TranscribeOptions,
  onWarning?: (message: string) => void,
): Promise<ITranscriptEntry[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const audioBuffer = await readFile(audioPath);
    const blob = new Blob([audioBuffer], { type: 'audio/wav' });

    const formData = new FormData();
    formData.append('file', blob, 'audio.wav');
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'segment');

    const language = opts.language || process.env.WHISPER_LANGUAGE;
    if (language) {
      formData.append('language', language);
    }

    const prompt = opts.initialPrompt || process.env.WHISPER_PROMPT;
    if (prompt) {
      formData.append('prompt', prompt);
    }

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      onWarning?.(`OpenAI transcription API returned HTTP ${response.status}.`);
      return null;
    }

    const data = (await response.json()) as Record<string, unknown>;

    if (Array.isArray(data['segments'])) {
      return (data['segments'] as Record<string, unknown>[])
        .filter(
          (seg) => typeof seg['text'] === 'string' && (seg['text'] as string).trim().length > 0,
        )
        .map((seg) => ({
          time: formatTimestamp(Math.round((seg['start'] as number) ?? 0)),
          text: (seg['text'] as string).trim(),
        }));
    }

    // Fallback: if only text is returned (no segments)
    if (typeof data['text'] === 'string' && (data['text'] as string).trim().length > 0) {
      return [{ time: '0:00', text: (data['text'] as string).trim() }];
    }

    return null;
  } catch (e: unknown) {
    onWarning?.(`OpenAI transcription failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadTransformers(): Promise<any> {
  try {
    // Dynamic import — package is optional, not in dependencies
    return await import(/* webpackIgnore: true */ '@huggingface/transformers' + '');
  } catch {
    return null;
  }
}
