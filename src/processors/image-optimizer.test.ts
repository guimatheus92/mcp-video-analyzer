import { describe, it, expect } from 'vitest';
import { statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { optimizeFrame, optimizeFrames } from './image-optimizer.js';
import { createTempDir, cleanupTempDir } from '../utils/temp-files.js';
import { createTestImage } from '../../test/helpers/index.js';

describe('optimizeFrame', () => {
  it('resizes large image to max 800px width', async () => {
    const tempDir = await createTempDir();
    try {
      const inputPath = await createTestImage(tempDir, 'large.png', { width: 1600, height: 1200 });
      const outputPath = join(tempDir, 'optimized.jpg');

      await optimizeFrame(inputPath, outputPath);

      const metadata = await sharp(outputPath).metadata();
      expect(metadata.width).toBe(800);
      expect(metadata.format).toBe('jpeg');
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it('does not enlarge small images', async () => {
    const tempDir = await createTempDir();
    try {
      const inputPath = await createTestImage(tempDir, 'small.png', { width: 400, height: 300 });
      const outputPath = join(tempDir, 'optimized.jpg');

      await optimizeFrame(inputPath, outputPath);

      const metadata = await sharp(outputPath).metadata();
      expect(metadata.width).toBe(400);
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it('produces smaller file than input', async () => {
    const tempDir = await createTempDir();
    try {
      const inputPath = await createTestImage(tempDir, 'big.png', { width: 1600, height: 1200 });
      const outputPath = join(tempDir, 'compressed.jpg');

      await optimizeFrame(inputPath, outputPath);

      const inputSize = statSync(inputPath).size;
      const outputSize = statSync(outputPath).size;
      expect(outputSize).toBeLessThan(inputSize);
    } finally {
      await cleanupTempDir(tempDir);
    }
  });
});

describe('optimizeFrames', () => {
  it('optimizes multiple frames', async () => {
    const tempDir = await createTempDir();
    try {
      const inputs = await Promise.all([
        createTestImage(tempDir, 'frame1.png', { width: 1000, height: 800 }),
        createTestImage(tempDir, 'frame2.png', { width: 1000, height: 800 }),
        createTestImage(tempDir, 'frame3.png', { width: 1000, height: 800 }),
      ]);

      const results = await optimizeFrames(inputs, tempDir);

      expect(results).toHaveLength(3);
      for (const path of results) {
        expect(existsSync(path)).toBe(true);
        const metadata = await sharp(path).metadata();
        expect(metadata.format).toBe('jpeg');
        expect(metadata.width).toBeLessThanOrEqual(800);
      }
    } finally {
      await cleanupTempDir(tempDir);
    }
  });
});
