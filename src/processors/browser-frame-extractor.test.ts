import { describe, expect, it } from 'vitest';
import { generateTimestamps } from './browser-frame-extractor.js';

describe('browser-frame-extractor', () => {
  describe('generateTimestamps', () => {
    it('returns empty array for zero duration', () => {
      expect(generateTimestamps(0, 10)).toEqual([]);
    });

    it('returns empty array for zero maxFrames', () => {
      expect(generateTimestamps(60, 0)).toEqual([]);
    });

    it('returns empty array for negative duration', () => {
      expect(generateTimestamps(-10, 5)).toEqual([]);
    });

    it('distributes timestamps evenly across a 60s video', () => {
      const timestamps = generateTimestamps(60, 20);
      expect(timestamps.length).toBeGreaterThan(0);
      expect(timestamps.length).toBeLessThanOrEqual(20);
      // All timestamps should be between 0 and 60 (exclusive)
      for (const ts of timestamps) {
        expect(ts).toBeGreaterThan(0);
        expect(ts).toBeLessThan(60);
      }
    });

    it('limits frames based on duration (1 frame per 5 seconds)', () => {
      // 15-second video → max 3 frames (15/5 = 3)
      const timestamps = generateTimestamps(15, 100);
      expect(timestamps.length).toBeLessThanOrEqual(3);
    });

    it('respects maxFrames limit', () => {
      // 300-second video could generate 60 frames but limited to 5
      const timestamps = generateTimestamps(300, 5);
      expect(timestamps.length).toBeLessThanOrEqual(5);
    });

    it('handles very short videos', () => {
      // 3-second video → 0 frames (3/5 rounds down to 0, max(1, 0) = 1)
      const timestamps = generateTimestamps(3, 10);
      // Should get at most 1 frame
      expect(timestamps.length).toBeLessThanOrEqual(1);
    });

    it('timestamps are sorted ascending', () => {
      const timestamps = generateTimestamps(120, 10);
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i]).toBeGreaterThan(timestamps[i - 1]);
      }
    });
  });
});
