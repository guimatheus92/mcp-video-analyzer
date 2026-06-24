import sharp from 'sharp';

interface OptimizeOptions {
  maxWidth?: number;
  quality?: number;
}

export async function optimizeFrame(
  inputPath: string,
  outputPath: string,
  options: OptimizeOptions = {},
): Promise<string> {
  const maxWidth = options.maxWidth ?? 800;
  const quality = options.quality ?? 70;

  await sharp(inputPath)
    .resize({ width: maxWidth, withoutEnlargement: true })
    .jpeg({ quality })
    .toFile(outputPath);

  return outputPath;
}

/**
 * Produce an OCR-optimized copy of a frame: grayscale, 2× upscale, and contrast
 * normalization. These three steps reliably lift Tesseract accuracy on stylized
 * on-screen text (prices, dates, coupons, CTAs — common in Reels/Stories)
 * without the over-aggressive hard binarization that destroys thin text laid
 * over photos. Tesseract applies its own Otsu thresholding internally, so we
 * deliberately stop short of a manual threshold. Returns the output path.
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
