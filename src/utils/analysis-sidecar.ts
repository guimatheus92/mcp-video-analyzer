import { existsSync, statSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { IAnalysisResult, ITranscriptEntry } from '../types.js';
import { envFlag } from './env.js';
import { toLocalPath } from './url-detector.js';

/**
 * Persistent, resumable analysis cache written *next to the source video* —
 * opt-in via `MCP_WRITE_SIDECARS=1`. Reprocessing a large local corpus is
 * expensive and the in-memory cache is lost on restart; sidecars make the work
 * survivable and let an external transcription pipeline (GPU Whisper) and this
 * MCP share results through the filesystem.
 *
 * Two artifacts per video:
 *   - `<stem>.vtt`          — the transcript, so a later call reuses it via the
 *                             existing sidecar reader and skips Whisper entirely.
 *   - `<stem>.analysis.json`— full result (frames + OCR + timeline), keyed by the
 *                             video's `mtime:size` stamp and the analysis params.
 *                             Optimized frames are copied into `<stem>.frames/`
 *                             so the images survive temp-dir cleanup.
 */

const SIDECAR_VERSION = 1;

interface PersistedAnalysis {
  version: number;
  /** `mtime:size` of the source video when written — invalidates on edit. */
  stamp: string;
  /** Analysis params this result was produced with (detail/maxFrames/etc.). */
  params: Record<string, unknown>;
  result: IAnalysisResult;
}

/** Whether persistent sidecar writing is enabled (`MCP_WRITE_SIDECARS=1`). */
export function sidecarsEnabled(): boolean {
  return envFlag(process.env.MCP_WRITE_SIDECARS);
}

function fileStamp(path: string): string | null {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function analysisJsonPath(videoPath: string): string {
  const stem = basename(videoPath, extname(videoPath));
  return join(dirname(videoPath), `${stem}.analysis.json`);
}

function framesDir(videoPath: string): string {
  const stem = basename(videoPath, extname(videoPath));
  return join(dirname(videoPath), `${stem}.frames`);
}

function vttPath(videoPath: string): string {
  const stem = basename(videoPath, extname(videoPath));
  return join(dirname(videoPath), `${stem}.vtt`);
}

function sameParams(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) sorted[key] = obj[key];
  return sorted;
}

/**
 * Read a persisted analysis for `url` if one exists and is still valid for the
 * given `params` (matching video stamp + params). Frame entries whose image
 * files no longer exist are dropped so the result stays honest. Returns null
 * for non-local sources, a missing/stale sidecar, or any read/parse error.
 */
export async function readAnalysisSidecar(
  url: string,
  params: Record<string, unknown>,
): Promise<IAnalysisResult | null> {
  const videoPath = toLocalPath(url);
  if (!videoPath) return null;

  const jsonPath = analysisJsonPath(videoPath);
  if (!existsSync(jsonPath)) return null;

  try {
    const parsed = JSON.parse(await readFile(jsonPath, 'utf8')) as PersistedAnalysis;
    if (parsed.version !== SIDECAR_VERSION) return null;
    if (parsed.stamp !== fileStamp(videoPath)) return null;
    if (!sameParams(parsed.params ?? {}, params)) return null;

    const result = parsed.result;
    result.frames = (result.frames ?? []).filter((f) => existsSync(f.filePath));
    return result;
  } catch {
    return null;
  }
}

/**
 * Persist analysis sidecars next to the source video when `MCP_WRITE_SIDECARS`
 * is enabled. Returns the list of files/dirs written (empty when disabled, when
 * the source isn't local, or on failure — writing is best-effort).
 *
 * `transcriptFromWhisper` gates the `.vtt`: we only write a transcript we
 * generated ourselves, and never clobber an existing `<stem>.vtt` (which may be
 * the user's own richer transcript from an external pipeline).
 */
export async function writeAnalysisSidecars(
  url: string,
  result: IAnalysisResult,
  params: Record<string, unknown>,
  opts: { transcriptFromWhisper: boolean },
): Promise<string[]> {
  if (!sidecarsEnabled()) return [];

  const videoPath = toLocalPath(url);
  if (!videoPath) return [];

  const stamp = fileStamp(videoPath);
  if (!stamp) return [];

  const written: string[] = [];

  try {
    // Copy optimized frames into a durable sibling dir and rewrite paths so the
    // persisted JSON points at images that survive temp-dir cleanup.
    const persistedFrames = result.frames;
    let jsonFrames = result.frames;
    if (result.frames.length > 0) {
      const dir = framesDir(videoPath);
      await mkdir(dir, { recursive: true });
      jsonFrames = [];
      for (let i = 0; i < persistedFrames.length; i++) {
        const frame = persistedFrames[i];
        const dest = join(dir, `frame_${String(i + 1).padStart(3, '0')}.jpg`);
        try {
          await copyFile(frame.filePath, dest);
          jsonFrames.push({ ...frame, filePath: dest });
        } catch {
          // Skip a frame we couldn't copy; keep the rest.
        }
      }
      written.push(dir);
    }

    const payload: PersistedAnalysis = {
      version: SIDECAR_VERSION,
      stamp,
      params,
      result: { ...result, frames: jsonFrames },
    };
    const jsonPath = analysisJsonPath(videoPath);
    await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    written.push(jsonPath);

    // Transcript sidecar — only our own Whisper output, never overwriting one
    // already on disk.
    if (opts.transcriptFromWhisper && result.transcript.length > 0) {
      const vtt = vttPath(videoPath);
      if (!existsSync(vtt)) {
        await writeFile(vtt, transcriptToVtt(result.transcript), 'utf8');
        written.push(vtt);
      }
    }
  } catch {
    // Best-effort: a write failure must never fail the analysis.
  }

  return written;
}

/** Convert a "M:SS" / "H:MM:SS" timestamp to whole seconds (lenient). */
function tsToSeconds(ts: string): number {
  const parts = ts.split(':').map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] ?? 0;
}

function secondsToVtt(total: number): string {
  const safe = Math.max(0, total);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${String(ms).padStart(3, '0')}`;
}

/**
 * Serialize transcript entries to a minimal WEBVTT document. Cue end times use
 * the entry's `endTime` when present, otherwise the next entry's start (or +3s
 * for the last cue). Speakers are emitted as `<v Name>` so the existing VTT
 * parser round-trips them back into `speaker`.
 */
export function transcriptToVtt(entries: ITranscriptEntry[]): string {
  const lines: string[] = ['WEBVTT', ''];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const startSec = tsToSeconds(entry.time);
    const nextStart = entries[i + 1] ? tsToSeconds(entries[i + 1].time) : startSec + 3;
    const endSec = entry.endTime ? tsToSeconds(entry.endTime) : nextStart;

    lines.push(`${secondsToVtt(startSec)} --> ${secondsToVtt(Math.max(endSec, startSec + 1))}`);
    lines.push(entry.speaker ? `<v ${entry.speaker}>${entry.text}</v>` : entry.text);
    lines.push('');
  }

  return lines.join('\n');
}
