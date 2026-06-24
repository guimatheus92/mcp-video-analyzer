import sharp from 'sharp';
import type { IFrameResult } from '../types.js';

const HASH_WIDTH = 9;
const HASH_HEIGHT = 8;

/**
 * Check if a frame is effectively black/blank.
 * Computes the mean brightness of the image — if below threshold, it's black.
 */
export async function isBlackFrame(filePath: string, threshold = 10): Promise<boolean> {
  try {
    const { channels } = await sharp(filePath).stats();
    // Average the mean of all channels (R, G, B)
    const meanBrightness = channels.reduce((sum, ch) => sum + ch.mean, 0) / channels.length;
    return meanBrightness < threshold;
  } catch {
    return false; // If we can't analyze, keep the frame
  }
}

/**
 * Filter out black/blank frames from the array.
 * Returns the filtered frames and count of removed frames.
 */
export async function filterBlackFrames(
  frames: IFrameResult[],
  threshold = 10,
): Promise<{ frames: IFrameResult[]; removedCount: number }> {
  if (frames.length === 0) return { frames, removedCount: 0 };

  const results = await Promise.all(
    frames.map(async (frame) => ({
      frame,
      isBlack: await isBlackFrame(frame.filePath, threshold),
    })),
  );

  const filtered = results.filter((r) => !r.isBlack).map((r) => r.frame);

  return {
    frames: filtered,
    removedCount: frames.length - filtered.length,
  };
}

/**
 * Compute a difference hash (dHash) for an image.
 * Resize to 9x8 grayscale, then compare each pixel to its right neighbor.
 * Returns a Buffer of 9 bytes (72 bits), one bit per pixel comparison.
 */
export async function computeDHash(imagePath: string): Promise<Buffer> {
  const pixels = await sharp(imagePath)
    .greyscale()
    .resize(HASH_WIDTH, HASH_HEIGHT, { fit: 'fill' })
    .raw()
    .toBuffer();

  // 8 columns of comparisons (9 pixels wide → 8 diffs) × 8 rows = 64 bits
  // We use 72 bits (9×8) for simplicity — compare each pixel to its right neighbor
  const bits: number[] = [];
  for (let y = 0; y < HASH_HEIGHT; y++) {
    for (let x = 0; x < HASH_WIDTH - 1; x++) {
      const left = pixels[y * HASH_WIDTH + x];
      const right = pixels[y * HASH_WIDTH + x + 1];
      bits.push(left > right ? 1 : 0);
    }
  }

  // Pack bits into bytes
  const bytes = Buffer.alloc(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) {
      bytes[Math.floor(i / 8)] |= 1 << (7 - (i % 8));
    }
  }

  return bytes;
}

/**
 * Compute Hamming distance between two hashes (number of differing bits).
 */
export function hammingDistance(a: Buffer, b: Buffer): number {
  const len = Math.min(a.length, b.length);
  let distance = 0;

  for (let i = 0; i < len; i++) {
    let xor = a[i] ^ b[i];
    while (xor) {
      distance += xor & 1;
      xor >>= 1;
    }
  }

  return distance;
}

/**
 * Remove near-duplicate consecutive frames based on perceptual similarity.
 *
 * Computes dHash for each frame and drops frames that are too similar
 * to the previous kept frame (Hamming distance below threshold).
 *
 * @param frames - Array of frame results to deduplicate
 * @param maxDistance - Maximum Hamming distance to consider frames as duplicates (default: 5).
 *   Lower = more aggressive dedup. Range: 0 (identical only) to 64 (keep all).
 * @returns Deduplicated frames array
 */
export async function deduplicateFrames(
  frames: IFrameResult[],
  maxDistance = 5,
): Promise<IFrameResult[]> {
  if (frames.length <= 1) return frames;

  const hashes = await Promise.all(frames.map((f) => computeDHash(f.filePath).catch(() => null)));

  const result: IFrameResult[] = [frames[0]];
  let lastKeptHash = hashes[0];

  for (let i = 1; i < frames.length; i++) {
    const hash = hashes[i];

    // Keep frame if we couldn't hash it (safe fallback) or if it's different enough
    if (!hash || !lastKeptHash || hammingDistance(lastKeptHash, hash) > maxDistance) {
      result.push(frames[i]);
      lastKeptHash = hash;
    }
  }

  return result;
}

function normalizeOcrText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Like {@link deduplicateFrames}, but **OCR-text-aware**: a frame survives if it
 * is visually distinct from the last kept frame *or* its on-screen text differs.
 *
 * This is the right dedup for static-background clips whose only change is a text
 * overlay (Reels/Stories, slides): a coarse perceptual hash barely registers a
 * small text-region change, so plain visual dedup would silently merge frames
 * that carry different prices/dates/captions and starve OCR. Truly identical
 * frames (same visuals *and* same text) are still dropped, preserving token economy.
 *
 * @param frames - frames to deduplicate
 * @param texts - OCR text per frame, aligned by index (use `''` for none/low-confidence)
 * @param maxDistance - visual Hamming threshold (see {@link deduplicateFrames})
 * @returns indices of the frames to keep, in order
 */
export async function dedupeKeepingTextChanges(
  frames: IFrameResult[],
  texts: string[],
  maxDistance = 5,
): Promise<number[]> {
  if (frames.length <= 1) return frames.map((_, i) => i);

  const hashes = await Promise.all(frames.map((f) => computeDHash(f.filePath).catch(() => null)));

  const kept: number[] = [0];
  let lastHash = hashes[0];
  let lastText = normalizeOcrText(texts[0] ?? '');

  for (let i = 1; i < frames.length; i++) {
    const hash = hashes[i];
    const text = normalizeOcrText(texts[i] ?? '');

    const visuallyDifferent = !hash || !lastHash || hammingDistance(lastHash, hash) > maxDistance;
    const textChanged = text.length > 0 && text !== lastText;

    if (visuallyDifferent || textChanged) {
      kept.push(i);
      lastHash = hash;
      if (text.length > 0) lastText = text;
    }
  }

  return kept;
}
