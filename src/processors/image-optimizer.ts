import sharp from 'sharp';
import { envInt } from '../utils/env.js';

const DEFAULT_MAX_WIDTH = 800;
const DEFAULT_QUALITY = 70;

interface OptimizeOptions {
  maxWidth?: number;
  quality?: number;
}

/**
 * Warn once per rejected value, on stderr (stdout is reserved for the MCP
 * protocol and the CLI's JSON document).
 *
 * A mistyped `MCP_FRAME_MAX_WIDTH` falls back to the 800 px cap — the exact
 * downscale the setting exists to escape — and the frames come back looking
 * normal, so nothing else in the pipeline can tell the operator their setting
 * was thrown away.
 */
const warnedEnvValues = new Set<string>();
function warnInvalidEnvOnce(name: string, raw: string, expected: string, fallback: number): void {
  const seen = `${name}=${raw}`;
  if (warnedEnvValues.has(seen)) return;
  warnedEnvValues.add(seen);
  process.stderr.write(
    `[mcp-video-analyzer] Ignoring ${name}="${raw}" - expected ${expected}; using ${fallback}.\n`,
  );
}

/**
 * Default width cap for emitted frames, in pixels. The 800 px default keeps
 * token cost sane for the common case (talking-head clips, Reels, bug repros)
 * where the subject is large in frame.
 *
 * `MCP_FRAME_MAX_WIDTH=0` (or `native`) emits frames at source resolution —
 * needed for dense UI captures whose payload is small text. Prefer the per-call
 * `maxWidth` tool parameter: the server starts once per session, so an
 * environment variable cannot differ between an overview of a YouTube clip and
 * a close read of a screen recording.
 */
function configuredMaxWidth(): number {
  const raw = process.env.MCP_FRAME_MAX_WIDTH?.trim();
  if (!raw) return DEFAULT_MAX_WIDTH;
  if (/^(native|full|original)$/i.test(raw)) return 0;
  // -1 as the fallback distinguishes "unparsable" from a legitimate 0/800.
  const width = envInt(raw, -1);
  if (width >= 0) return width;
  warnInvalidEnvOnce(
    'MCP_FRAME_MAX_WIDTH',
    raw,
    'a plain integer >= 0, or native/full/original',
    DEFAULT_MAX_WIDTH,
  );
  return DEFAULT_MAX_WIDTH;
}

/** JPEG quality for emitted frames; raise it when thin glyphs matter. */
function configuredQuality(): number {
  const raw = process.env.MCP_FRAME_JPEG_QUALITY?.trim();
  if (!raw) return DEFAULT_QUALITY;
  // 0 is out of range anyway, so it doubles as the "unparsable" sentinel.
  const quality = envInt(raw, 0);
  if (quality >= 1 && quality <= 100) return quality;
  warnInvalidEnvOnce('MCP_FRAME_JPEG_QUALITY', raw, 'a plain integer 1-100', DEFAULT_QUALITY);
  return DEFAULT_QUALITY;
}

/**
 * The emitted-frame width a call will actually use, in the shape the analysis
 * cache/sidecar key wants: the per-call value, else `MCP_FRAME_MAX_WIDTH`, else
 * the default — with the default itself reported as `undefined` so it drops out
 * of the key.
 *
 * Keying on the *effective* width rather than the raw parameter matters twice:
 * a cached 800 px result must not be served to a later `maxWidth: 0` call, and
 * a sidecar written under one `MCP_FRAME_MAX_WIDTH` must not be reused after
 * the operator changes it. Normalizing the default back to `undefined` keeps
 * every sidecar written before this parameter existed valid — they were all
 * produced at exactly that width.
 */
export function keyedFrameMaxWidth(explicit: number | undefined): number | undefined {
  const effective = explicit ?? configuredMaxWidth();
  return effective === DEFAULT_MAX_WIDTH ? undefined : effective;
}

export async function optimizeFrame(
  inputPath: string,
  outputPath: string,
  options: OptimizeOptions = {},
): Promise<string> {
  const maxWidth = options.maxWidth ?? configuredMaxWidth();
  const quality = options.quality ?? configuredQuality();

  let pipeline = sharp(inputPath);
  if (maxWidth > 0) {
    pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true });
  }
  await pipeline.jpeg({ quality }).toFile(outputPath);

  return outputPath;
}

/**
 * Produce an OCR-optimized copy of a frame: grayscale, 2× upscale, contrast
 * normalization, and a mild sharpen. These steps reliably lift Tesseract
 * accuracy on stylized on-screen text (prices, dates, coupons, CTAs — common in
 * Reels/Stories) without the over-aggressive hard binarization that destroys
 * thin text laid over photos. Tesseract applies its own Otsu thresholding
 * internally, so we deliberately stop short of a manual threshold. Returns the
 * output path.
 */
export async function preprocessForOcr(inputPath: string, outputPath: string): Promise<string> {
  const meta = await sharp(inputPath).metadata();
  const targetWidth = meta.width ? Math.min(meta.width * 2, 3000) : undefined;

  let pipeline = sharp(inputPath).grayscale();
  if (targetWidth) {
    pipeline = pipeline.resize({ width: targetWidth, withoutEnlargement: false });
  }
  await pipeline.normalise().sharpen().png().toFile(outputPath);

  return outputPath;
}

export async function optimizeFrames(
  inputPaths: string[],
  outputDir: string,
  options: OptimizeOptions = {},
): Promise<string[]> {
  const results: string[] = [];

  for (const inputPath of inputPaths) {
    const filename = inputPath.split(/[/\\]/).pop() ?? 'frame.jpg';
    const outputPath = `${outputDir}/opt_${filename}`;
    await optimizeFrame(inputPath, outputPath, options);
    results.push(outputPath);
  }

  return results;
}

/** An emitted (optimized) frame path → the full-resolution frame it came from. */
export type FrameOriginals = ReadonlyMap<string, string>;

interface OptimizeFramesOptions extends OptimizeOptions {
  /**
   * Sink for the failure message when optimization throws. Optimization is an
   * output concern, so a failure degrades to the raw frames rather than losing
   * them — but silently swallowing it hides a real disk/sharp problem.
   */
  onWarning?: (message: string) => void;
}

/**
 * Optimize frames for emission while keeping the reverse mapping OCR needs.
 *
 * `optimizeFrames` replaces a frame's single `filePath` with a lossy copy, yet
 * every OCR-running caller still needs the source pixels: recognition on the
 * downscale throws away the resolution Tesseract needs, and on a dense UI
 * capture that cascades — no text means the text-aware dedup has nothing to
 * compare, so it degrades to the coarse visual hash and a static-layout clip
 * collapses to a single frame. Reconstructing that mapping in each caller is
 * how one copy of the invariant drifts from the other, so it lives here.
 *
 * Pass the surviving frames back through {@link ocrSourceFrames} after any
 * filtering/dedup step to get the OCR input.
 */
export async function optimizeFramesKeepingOriginals<T extends { filePath: string }>(
  frames: T[],
  outputDir: string,
  options: OptimizeFramesOptions = {},
): Promise<{ frames: T[]; originals: FrameOriginals }> {
  const { onWarning, ...optimizeOptions } = options;

  const optimizedPaths = await optimizeFrames(
    frames.map((f) => f.filePath),
    outputDir,
    optimizeOptions,
  ).catch((e: unknown) => {
    onWarning?.(`Frame optimization failed: ${e instanceof Error ? e.message : String(e)}`);
    return frames.map((f) => f.filePath);
  });

  const originals = new Map<string, string>();
  const emitted = frames.map((frame, i) => {
    const optimized = optimizedPaths[i] ?? frame.filePath;
    if (optimized !== frame.filePath) originals.set(optimized, frame.filePath);
    return { ...frame, filePath: optimized };
  });

  return { frames: emitted, originals };
}

/**
 * Swap each frame's path back to its pre-optimization original, for OCR. Frames
 * with no recorded original (browser fallback, or a failed optimization) are
 * passed through untouched.
 */
export function ocrSourceFrames<T extends { filePath: string }>(
  frames: T[],
  originals: FrameOriginals,
): T[] {
  return frames.map((frame) => {
    const original = originals.get(frame.filePath);
    return original ? { ...frame, filePath: original } : frame;
  });
}
