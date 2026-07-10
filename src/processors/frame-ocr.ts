import { mkdir, rm } from 'node:fs/promises';
import type { IFrameResult, IOcrEntry } from '../types.js';
import { persistentCacheDir } from '../utils/temp-files.js';
import { preprocessForOcr } from './image-optimizer.js';

/**
 * OCR result for a single frame. Alias of the canonical {@link IOcrEntry} in
 * types.ts — kept as a named export for the OCR module's API while remaining a
 * single source of truth for the shape.
 */
export type IOcrResult = IOcrEntry;

/** Derive the temp path for a frame's OCR-preprocessed copy (lossless PNG). */
function ocrPreprocessPath(framePath: string): string {
  return `${framePath.replace(/\.[^.\\/]+$/, '')}.ocr.png`;
}

/** A result is "meaningful" (kept in output / trusted for dedup) above these. */
const MIN_TEXT_LENGTH = 3;
const MIN_CONFIDENCE = 50;

/** True for OCR results worth surfacing — filters short/low-confidence noise. */
export function isMeaningfulOcr(result: IOcrResult): boolean {
  return result.text.length > MIN_TEXT_LENGTH && result.confidence > MIN_CONFIDENCE;
}

/**
 * Run OCR on every frame, returning one result per input frame (aligned 1:1 by
 * index). Frames that yield no text or fail recognition come back with an empty
 * string and confidence 0 rather than being dropped — callers that need the
 * raw, per-frame signal (e.g. text-aware dedup) rely on this alignment.
 *
 * Returns `[]` when tesseract.js isn't available (alignment is then the caller's
 * responsibility to detect via length mismatch).
 */
export async function ocrFrames(
  frames: IFrameResult[],
  language = 'eng+por',
  onProgress?: (completed: number, total: number) => void,
): Promise<IOcrResult[]> {
  const Tesseract = await loadTesseract();
  if (!Tesseract) return [];

  // Preprocessing (grayscale + 2× upscale + contrast normalization) materially
  // improves OCR of stylized on-screen text. On by default; set
  // MCP_OCR_PREPROCESS=0 to OCR the raw frames instead.
  const preprocess = process.env.MCP_OCR_PREPROCESS !== '0';

  // Cache ~MB-sized .traineddata downloads in a stable temp dir — tesseract.js
  // defaults to the process cwd, which pollutes whatever directory the
  // server/CLI happens to run from (an agent's project root under npx).
  // A mkdir failure propagates: both callers catch it into an "OCR failed:"
  // warning, which beats a far-away traineddata write error (or a silent
  // fallback to cwd — the very bug this cachePath exists to fix).
  const cachePath = persistentCacheDir('tessdata');
  await mkdir(cachePath, { recursive: true });
  const worker = await Tesseract.createWorker(language, undefined, { cachePath });

  try {
    const results: IOcrResult[] = [];

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];

      let target = frame.filePath;
      let scratch: string | null = null;
      if (preprocess) {
        const out = ocrPreprocessPath(frame.filePath);
        const ok = await preprocessForOcr(frame.filePath, out)
          .then(() => true)
          .catch(() => false);
        if (ok) {
          target = out;
          scratch = out;
        }
      }

      let text = '';
      let confidence = 0;
      try {
        const { data } = await worker.recognize(target);
        text = data.text.trim();
        confidence = Math.round(data.confidence);
      } catch {
        // Recognition failed for this frame — keep the aligned empty entry.
      } finally {
        if (scratch) await rm(scratch, { force: true }).catch(() => undefined);
      }

      results.push({ time: frame.time, text, confidence });
      onProgress?.(i + 1, frames.length);
    }

    return results;
  } finally {
    await worker.terminate();
  }
}

/**
 * Extract text from video frames using OCR (tesseract.js).
 * Useful for screencasts, code demos, error messages, and UI text.
 *
 * Only includes results with meaningful text (confidence > 50%, text length > 3).
 */
export async function extractTextFromFrames(
  frames: IFrameResult[],
  language = 'eng+por',
  onProgress?: (completed: number, total: number) => void,
): Promise<IOcrResult[]> {
  const all = await ocrFrames(frames, language, onProgress);
  return all.filter(isMeaningfulOcr);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadTesseract(): Promise<any> {
  try {
    return await import('tesseract.js');
  } catch {
    return null;
  }
}
