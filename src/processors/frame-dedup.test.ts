import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import {
  computeDHash,
  hammingDistance,
  deduplicateFrames,
  isBlackFrame,
  filterBlackFrames,
} from './frame-dedup.js';
import { createTestImage } from '../../test/helpers/index.js';
import type { IFrameResult } from '../types.js';

describe('frame-dedup', () => {
  describe('computeDHash', () => {
    it('returns a buffer for a valid image', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dedup-test-'));
      const path = await createTestImage(dir, 'test.jpg', { color: { r: 128, g: 128, b: 128 } });

      const hash = await computeDHash(path);
      expect(hash).toBeInstanceOf(Buffer);
      expect(hash.length).toBe(8); // 64 bits = 8 bytes
    });

    it('returns identical hashes for identical images', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dedup-test-'));
      const path1 = await createTestImage(dir, 'a.jpg', { color: { r: 200, g: 100, b: 50 } });
      const path2 = await createTestImage(dir, 'b.jpg', { color: { r: 200, g: 100, b: 50 } });

      const hash1 = await computeDHash(path1);
      const hash2 = await computeDHash(path2);
      expect(hammingDistance(hash1, hash2)).toBe(0);
    });

    it('returns different hashes for very different images', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dedup-test-'));

      // Create a half-black/half-white image (left half black, right half white)
      const splitPath = join(dir, 'split.jpg');
      const pixels = Buffer.alloc(100 * 100 * 3);
      for (let y = 0; y < 100; y++) {
        for (let x = 0; x < 100; x++) {
          const idx = (y * 100 + x) * 3;
          const val = x < 50 ? 0 : 255;
          pixels[idx] = val;
          pixels[idx + 1] = val;
          pixels[idx + 2] = val;
        }
      }
      await sharp(pixels, { raw: { width: 100, height: 100, channels: 3 } })
        .jpeg()
        .toFile(splitPath);

      // Create a checkerboard pattern
      const checkerPath = join(dir, 'checker.jpg');
      const checkerPixels = Buffer.alloc(100 * 100 * 3);
      for (let y = 0; y < 100; y++) {
        for (let x = 0; x < 100; x++) {
          const idx = (y * 100 + x) * 3;
          const val = (Math.floor(x / 25) + Math.floor(y / 25)) % 2 === 0 ? 0 : 255;
          checkerPixels[idx] = val;
          checkerPixels[idx + 1] = val;
          checkerPixels[idx + 2] = val;
        }
      }
      await sharp(checkerPixels, { raw: { width: 100, height: 100, channels: 3 } })
        .jpeg()
        .toFile(checkerPath);

      const hash1 = await computeDHash(splitPath);
      const hash2 = await computeDHash(checkerPath);
      expect(hammingDistance(hash1, hash2)).toBeGreaterThan(5);
    });
  });

  describe('hammingDistance', () => {
    it('returns 0 for identical buffers', () => {
      const a = Buffer.from([0b10101010, 0b11001100]);
      expect(hammingDistance(a, a)).toBe(0);
    });

    it('returns correct distance for known values', () => {
      const a = Buffer.from([0b00000000]);
      const b = Buffer.from([0b11111111]);
      expect(hammingDistance(a, b)).toBe(8);
    });

    it('returns 1 for single bit difference', () => {
      const a = Buffer.from([0b00000000]);
      const b = Buffer.from([0b00000001]);
      expect(hammingDistance(a, b)).toBe(1);
    });
  });

  describe('deduplicateFrames', () => {
    it('returns same array for single frame', async () => {
      const frames: IFrameResult[] = [
        { time: '0:01', filePath: '/fake/path.jpg', mimeType: 'image/jpeg' },
      ];
      const result = await deduplicateFrames(frames);
      expect(result).toEqual(frames);
    });

    it('returns empty array for empty input', async () => {
      expect(await deduplicateFrames([])).toEqual([]);
    });

    it('removes duplicate solid-color frames', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dedup-test-'));
      const path1 = await createTestImage(dir, 'f1.jpg', { color: { r: 100, g: 100, b: 100 } });
      const path2 = await createTestImage(dir, 'f2.jpg', { color: { r: 100, g: 100, b: 100 } });
      const path3 = await createTestImage(dir, 'f3.jpg', { color: { r: 100, g: 100, b: 100 } });

      const frames: IFrameResult[] = [
        { time: '0:01', filePath: path1, mimeType: 'image/jpeg' },
        { time: '0:02', filePath: path2, mimeType: 'image/jpeg' },
        { time: '0:03', filePath: path3, mimeType: 'image/jpeg' },
      ];

      const result = await deduplicateFrames(frames);
      expect(result).toHaveLength(1); // All identical → keep first only
    });
  });

  describe('isBlackFrame', () => {
    it('detects a fully black frame', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'black-test-'));
      const path = await createTestImage(dir, 'black.jpg', { color: { r: 0, g: 0, b: 0 } });
      expect(await isBlackFrame(path)).toBe(true);
    });

    it('detects a nearly black frame', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'black-test-'));
      const path = await createTestImage(dir, 'dark.jpg', { color: { r: 5, g: 5, b: 5 } });
      expect(await isBlackFrame(path)).toBe(true);
    });

    it('does not flag a bright frame', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'black-test-'));
      const path = await createTestImage(dir, 'bright.jpg', { color: { r: 200, g: 200, b: 200 } });
      expect(await isBlackFrame(path)).toBe(false);
    });

    it('returns false for invalid file', async () => {
      expect(await isBlackFrame('/nonexistent/path.jpg')).toBe(false);
    });
  });

  describe('filterBlackFrames', () => {
    it('removes black frames from array', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'black-filter-'));
      const blackPath = await createTestImage(dir, 'black.jpg', { color: { r: 0, g: 0, b: 0 } });
      const brightPath = await createTestImage(dir, 'bright.jpg', {
        color: { r: 200, g: 100, b: 50 },
      });

      const frames: IFrameResult[] = [
        { time: '0:01', filePath: blackPath, mimeType: 'image/jpeg' },
        { time: '0:02', filePath: brightPath, mimeType: 'image/jpeg' },
        { time: '0:03', filePath: blackPath, mimeType: 'image/jpeg' },
      ];

      const result = await filterBlackFrames(frames);
      expect(result.frames).toHaveLength(1);
      expect(result.removedCount).toBe(2);
      expect(result.frames[0].time).toBe('0:02');
    });

    it('returns empty result for all-black frames', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'black-filter-'));
      const blackPath = await createTestImage(dir, 'black.jpg', { color: { r: 0, g: 0, b: 0 } });

      const frames: IFrameResult[] = [
        { time: '0:01', filePath: blackPath, mimeType: 'image/jpeg' },
      ];

      const result = await filterBlackFrames(frames);
      expect(result.frames).toHaveLength(0);
      expect(result.removedCount).toBe(1);
    });

    it('handles empty input', async () => {
      const result = await filterBlackFrames([]);
      expect(result.frames).toHaveLength(0);
      expect(result.removedCount).toBe(0);
    });
  });

  describe('deduplicateFrames - different frames', () => {
    it('keeps frames that are different enough', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dedup-test-'));

      // Create two visually distinct images (split vs checkerboard)
      const splitPath = join(dir, 'split.jpg');
      const splitPixels = Buffer.alloc(100 * 100 * 3);
      for (let y = 0; y < 100; y++) {
        for (let x = 0; x < 100; x++) {
          const idx = (y * 100 + x) * 3;
          const val = x < 50 ? 0 : 255;
          splitPixels[idx] = val;
          splitPixels[idx + 1] = val;
          splitPixels[idx + 2] = val;
        }
      }
      await sharp(splitPixels, { raw: { width: 100, height: 100, channels: 3 } })
        .jpeg()
        .toFile(splitPath);

      const checkerPath = join(dir, 'checker.jpg');
      const checkerPixels = Buffer.alloc(100 * 100 * 3);
      for (let y = 0; y < 100; y++) {
        for (let x = 0; x < 100; x++) {
          const idx = (y * 100 + x) * 3;
          const val = (Math.floor(x / 25) + Math.floor(y / 25)) % 2 === 0 ? 0 : 255;
          checkerPixels[idx] = val;
          checkerPixels[idx + 1] = val;
          checkerPixels[idx + 2] = val;
        }
      }
      await sharp(checkerPixels, { raw: { width: 100, height: 100, channels: 3 } })
        .jpeg()
        .toFile(checkerPath);

      const frames: IFrameResult[] = [
        { time: '0:01', filePath: splitPath, mimeType: 'image/jpeg' },
        { time: '0:05', filePath: checkerPath, mimeType: 'image/jpeg' },
      ];

      const result = await deduplicateFrames(frames);
      expect(result).toHaveLength(2); // Different patterns → both kept
    });
  });
});
