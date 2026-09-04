import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractBrowserFrames, generateTimestamps } from './browser-frame-extractor.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

// Without this, the "public URL gets past the guard" case below launches a real
// Chrome and navigates to the network on any machine that has one installed.
// `launch` rejecting is the documented no-Chrome path: extractBrowserFrames
// catches it and returns [].
vi.mock('puppeteer-core', () => ({
  default: { launch: vi.fn().mockRejectedValue(new Error('no chrome in this test')) },
  launch: vi.fn().mockRejectedValue(new Error('no chrome in this test')),
}));

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

  // The second SSRF sink (GHSA-hpmc-4g74-v53v). It was not in the report, and
  // it is the more dangerous of the two: it renders the internal response and
  // hands it back as a JPEG. Reached from analyze_video, get_frames,
  // get_frame_at and get_frame_burst whenever the download strategy fails.
  describe('extractBrowserFrames — blocked destinations', () => {
    it.each([
      'http://127.0.0.1:8931/x.mp4',
      'http://localhost:8080/video',
      'http://192.168.1.5/video',
      'http://169.254.169.254/latest/meta-data/',
      'ftp://example.com/x.mp4',
    ])('refuses %s before Chrome is launched', async (url) => {
      // Rejects rather than returning [] on purpose: every other zero-frame
      // outcome here is graceful degradation, so a silent [] would make a
      // refused destination indistinguishable from "no frames found".
      await expect(extractBrowserFrames(url, '/tmp/out', { timestamps: [1] })).rejects.toThrow();
    });

    it('still blocks metadata with the opt-in on', async () => {
      vi.stubEnv('MCP_ALLOW_PRIVATE_URLS', '1');
      await expect(
        extractBrowserFrames('http://169.254.169.254/latest.mp4', '/tmp/out', { timestamps: [1] }),
      ).rejects.toThrow(/metadata endpoint/i);
      vi.unstubAllEnvs();
    });

    it('gets past the guard for a public URL', async () => {
      // Proves the guard is not rejecting everything: this reaches the
      // puppeteer load, which returns [] when Chrome is absent.
      await expect(
        extractBrowserFrames('https://example.com/video.mp4', '/tmp/out', { timestamps: [1] }),
      ).resolves.toBeInstanceOf(Array);
    });
  });
});
