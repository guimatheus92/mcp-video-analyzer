import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestImage } from '../../test/helpers/index.js';
import { cleanupTempDir, createTempDir } from '../utils/temp-files.js';
import { optimizeFrame, optimizeFrames } from './image-optimizer.js';

// The width cap and JPEG quality are read from the environment at call time, so
// a developer who exported MCP_FRAME_MAX_WIDTH for their own use — precisely the
// audience these knobs exist for — would otherwise turn this suite red.
beforeEach(() => {
  vi.stubEnv('MCP_FRAME_MAX_WIDTH', '');
  vi.stubEnv('MCP_FRAME_JPEG_QUALITY', '');
});

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

  it('keeps source resolution when maxWidth is 0', async () => {
    const tempDir = await createTempDir();
    try {
      const inputPath = await createTestImage(tempDir, 'dense.png', { width: 1920, height: 1080 });
      const outputPath = join(tempDir, 'native.jpg');

      await optimizeFrame(inputPath, outputPath, { maxWidth: 0 });

      const metadata = await sharp(outputPath).metadata();
      expect(metadata.width).toBe(1920);
      expect(metadata.height).toBe(1080);
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it('honours an explicit maxWidth over the environment', async () => {
    const tempDir = await createTempDir();
    try {
      vi.stubEnv('MCP_FRAME_MAX_WIDTH', '640');
      const inputPath = await createTestImage(tempDir, 'wide.png', { width: 1920, height: 1080 });
      const outputPath = join(tempDir, 'explicit.jpg');

      await optimizeFrame(inputPath, outputPath, { maxWidth: 1280 });

      expect((await sharp(outputPath).metadata()).width).toBe(1280);
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it.each([
    ['0', 1920],
    ['native', 1920],
    ['1280', 1280],
    ['-100', 800], // negative — falls back
    ['800.5', 800], // fractional — falls back
    ['abc', 800], // garbage — falls back
    ['1e3', 800], // Number() would give 1000; strict parsing falls back
  ])('MCP_FRAME_MAX_WIDTH=%s gives width %i', async (value, expected) => {
    const tempDir = await createTempDir();
    try {
      vi.stubEnv('MCP_FRAME_MAX_WIDTH', value);
      const inputPath = await createTestImage(tempDir, 'env.png', { width: 1920, height: 1080 });
      const outputPath = join(tempDir, 'env.jpg');

      await optimizeFrame(inputPath, outputPath);

      expect((await sharp(outputPath).metadata()).width).toBe(expected);
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it('falls back to the default quality when the env value is out of range', async () => {
    const tempDir = await createTempDir();
    try {
      vi.stubEnv('MCP_FRAME_JPEG_QUALITY', '150');
      const inputPath = await createTestImage(tempDir, 'q.png', { width: 400, height: 300 });
      const outputPath = join(tempDir, 'q.jpg');

      await expect(optimizeFrame(inputPath, outputPath)).resolves.toBe(outputPath);
      expect(existsSync(outputPath)).toBe(true);
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
