import { join } from 'node:path';
import sharp from 'sharp';

interface CreateTestImageOptions {
  color?: { r: number; g: number; b: number };
  width?: number;
  height?: number;
  format?: 'jpeg' | 'png';
}

/**
 * Create a solid-color test image in the given directory.
 *
 * @param dir - Directory to create the image in
 * @param name - Filename (e.g., "test.jpg")
 * @param options - Image options (color, dimensions, format)
 * @returns Full path to the created image
 */
export async function createTestImage(
  dir: string,
  name: string,
  options: CreateTestImageOptions = {},
): Promise<string> {
  const {
    color = { r: 255, g: 0, b: 0 },
    width = 100,
    height = 100,
    format = name.endsWith('.png') ? 'png' : 'jpeg',
  } = options;

  const path = join(dir, name);
  const img = sharp({
    create: { width, height, channels: 3, background: color },
  });

  if (format === 'png') {
    await img.png().toFile(path);
  } else {
    await img.jpeg().toFile(path);
  }

  return path;
}
