import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestImage } from '../../test/helpers/index.js';
import { cleanupTempDir, createTempDir } from '../utils/temp-files.js';
import {
  keyedFrameMaxWidth,
  ocrSourceFrames,
  optimizeFrame,
  optimizeFrames,
  optimizeFramesKeepingOriginals,
  preprocessForOcr,
} from './image-optimizer.js';

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
    ['full', 1920], // documented alias — narrowing the regex must fail here
    ['original', 1920], // ditto
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

  it('applies an in-range MCP_FRAME_JPEG_QUALITY', async () => {
    // The only quality test asserted that a 150 resolves — it would still pass
    // if configuredQuality always returned the default, i.e. if the documented
    // "raise it when thin glyphs matter" knob quietly did nothing.
    const tempDir = await createTempDir();
    try {
      const inputPath = await createTestImage(tempDir, 'q-in.png', { width: 400, height: 300 });

      const defaultPath = join(tempDir, 'q70.jpg');
      await optimizeFrame(inputPath, defaultPath);

      vi.stubEnv('MCP_FRAME_JPEG_QUALITY', '95');
      const highPath = join(tempDir, 'q95.jpg');
      await optimizeFrame(inputPath, highPath);

      expect(statSync(highPath).size).toBeGreaterThan(statSync(defaultPath).size);
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it('falls back when MCP_FRAME_JPEG_QUALITY is below the range', async () => {
    // Only `>= 1` stops a 0 from reaching sharp.jpeg({ quality: 0 }), which
    // throws; the upper bound had a test, this half did not.
    const tempDir = await createTempDir();
    try {
      vi.stubEnv('MCP_FRAME_JPEG_QUALITY', '0');
      const inputPath = await createTestImage(tempDir, 'q-low.png', { width: 400, height: 300 });
      const outputPath = join(tempDir, 'q-low.jpg');

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

describe('optimizeFramesKeepingOriginals', () => {
  it('emits optimized frames and maps them back to the originals for OCR', async () => {
    // The invariant this helper owns: what the client receives is downscaled,
    // what OCR reads is not. It used to be rebuilt by hand in analyze-core and
    // analyze-moment, one copy each, with nothing shared to keep them in step.
    const tempDir = await createTempDir();
    try {
      const frames = [
        {
          time: '0:00',
          filePath: await createTestImage(tempDir, 'a.png', { width: 1000, height: 800 }),
          mimeType: 'image/jpeg',
        },
        {
          time: '0:01',
          filePath: await createTestImage(tempDir, 'b.png', { width: 1000, height: 800 }),
          mimeType: 'image/jpeg',
        },
      ];

      const { frames: emitted, originals } = await optimizeFramesKeepingOriginals(frames, tempDir, {
        maxWidth: 200,
      });

      expect(emitted.every((f) => basename(f.filePath).startsWith('opt_'))).toBe(true);
      expect((await sharp(emitted[0].filePath).metadata()).width).toBe(200);
      expect(emitted.map((f) => f.time)).toEqual(['0:00', '0:01']); // other fields ride along

      const ocrInput = ocrSourceFrames(emitted, originals);
      expect(ocrInput.map((f) => f.filePath)).toEqual(frames.map((f) => f.filePath));
      expect(ocrInput.map((f) => f.time)).toEqual(['0:00', '0:01']);
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it('degrades to the raw frames and reports the failure', async () => {
    const warnings: string[] = [];
    const frames = [
      { time: '0:00', filePath: join('no-such-dir', 'gone.png'), mimeType: 'image/jpeg' },
    ];

    const { frames: emitted, originals } = await optimizeFramesKeepingOriginals(
      frames,
      join('no-such-dir', 'out'),
      { onWarning: (w) => warnings.push(w) },
    );

    expect(emitted).toEqual(frames); // the frames themselves are never lost
    expect(originals.size).toBe(0); // nothing was optimized → nothing to swap back
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Frame optimization failed');
  });
});

describe('keyedFrameMaxWidth', () => {
  it('reports the default width as absent so old cache keys stay valid', () => {
    expect(keyedFrameMaxWidth(undefined)).toBeUndefined();
    expect(keyedFrameMaxWidth(800)).toBeUndefined();
    expect(keyedFrameMaxWidth(0)).toBe(0);
    expect(keyedFrameMaxWidth(1920)).toBe(1920);
  });

  it('resolves the env default, so changing it invalidates the sidecar', () => {
    // The parameter alone in the key would leave a sidecar written under
    // MCP_FRAME_MAX_WIDTH=800 valid for a session started with 1920.
    vi.stubEnv('MCP_FRAME_MAX_WIDTH', '0');
    expect(keyedFrameMaxWidth(undefined)).toBe(0);
    vi.stubEnv('MCP_FRAME_MAX_WIDTH', '1920');
    expect(keyedFrameMaxWidth(undefined)).toBe(1920);
    // An explicit per-call value still wins.
    expect(keyedFrameMaxWidth(640)).toBe(640);
  });
});

describe('invalid environment values', () => {
  it('warns once per rejected value instead of falling back silently', () => {
    // This PR exists because a downscale degraded OCR *silently*. A mistyped
    // MCP_FRAME_MAX_WIDTH reproduces that exact failure through the setting
    // meant to escape it, so the rejection has to surface somewhere.
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      vi.stubEnv('MCP_FRAME_MAX_WIDTH', '1920px');

      expect(keyedFrameMaxWidth(undefined)).toBeUndefined(); // fell back to 800
      expect(keyedFrameMaxWidth(undefined)).toBeUndefined();

      const warnings = writes.filter((w) => w.includes('MCP_FRAME_MAX_WIDTH'));
      expect(warnings).toHaveLength(1); // once per value, not once per frame
      expect(warnings[0]).toContain('1920px');
      expect(warnings[0]).toContain('800');
    } finally {
      spy.mockRestore();
    }
  });

  it('warns for an out-of-range JPEG quality', async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const tempDir = await createTempDir();
    try {
      vi.stubEnv('MCP_FRAME_JPEG_QUALITY', '250');
      const inputPath = await createTestImage(tempDir, 'q-warn.png', { width: 200, height: 150 });

      await optimizeFrame(inputPath, join(tempDir, 'q-warn.jpg'));

      expect(writes.filter((w) => w.includes('MCP_FRAME_JPEG_QUALITY'))).toHaveLength(1);
    } finally {
      spy.mockRestore();
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

describe('preprocessForOcr', () => {
  // Structural coverage for the actual OCR input path (grayscale + 2x upscale
  // + normalize + sharpen) — it had zero tests before this block. The
  // recognition-quality outcome lives in test/e2e/golden-ocr.e2e.test.ts.
  it('doubles the width and emits PNG', async () => {
    const tempDir = await createTempDir();
    try {
      const inputPath = await createTestImage(tempDir, 'ocr-in.png', { width: 400, height: 300 });
      const outputPath = join(tempDir, 'ocr-out.png');

      await preprocessForOcr(inputPath, outputPath);

      const metadata = await sharp(outputPath).metadata();
      expect(metadata.width).toBe(800);
      expect(metadata.format).toBe('png');
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it('caps the upscale at 3000px', async () => {
    const tempDir = await createTempDir();
    try {
      const inputPath = await createTestImage(tempDir, 'wide-in.png', { width: 1920, height: 200 });
      const outputPath = join(tempDir, 'wide-out.png');

      await preprocessForOcr(inputPath, outputPath);

      expect((await sharp(outputPath).metadata()).width).toBe(3000);
    } finally {
      await cleanupTempDir(tempDir);
    }
  });
});
