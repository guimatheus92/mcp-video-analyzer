import sharp from 'sharp';
import { envInt } from '../utils/env.js';

const DEFAULT_MAX_WIDTH = 800;
const DEFAULT_QUALITY = 70;

interface OptimizeOptions {
  maxWidth?: number;
  quality?: number;
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
  if (raw && /^(native|full|original)$/i.test(raw)) return 0;
  return envInt(raw, DEFAULT_MAX_WIDTH);
}

/** JPEG quality for emitted frames; raise it when thin glyphs matter. */
function configuredQuality(): number {
  const quality = envInt(process.env.MCP_FRAME_JPEG_QUALITY, DEFAULT_QUALITY);
  return quality >= 1 && quality <= 100 ? quality : DEFAULT_QUALITY;
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
