import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractBrowserFrames, generateTimestamps } from './browser-frame-extractor.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

// Resolves whatever the guard asks about to a PUBLIC address, so any refusal
// below comes from the address rules and not from a lookup failure. Individual
// tests override it to make a hostname resolve internal.
const dns = vi.hoisted(() => ({
  lookup: vi.fn<() => Promise<{ address: string; family: number }[]>>(),
}));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }));

// Without this, the "public URL gets past the guard" case below launches a real
// Chrome and navigates to the network on any machine that has one installed.
// `launch` rejecting is the documented no-Chrome path: extractBrowserFrames
// catches it and returns [].
const puppeteer = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('puppeteer-core', () => ({
  default: { launch: puppeteer.launch },
  launch: puppeteer.launch,
}));

beforeEach(() => {
  dns.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  puppeteer.launch.mockRejectedValue(new Error('no chrome in this test'));
});

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

  // The pre-flight check covers the FIRST hop only. Everything after it —
  // redirects Chrome follows internally, and every subresource the page asks
  // for — is gated by the interception handler alone. Mocking `launch` to
  // reject (as the block above needs) means that handler never runs, so these
  // drive it directly with a fake page.
  describe('extractBrowserFrames — request interception', () => {
    /** Run far enough into the function to capture the registered handler. */
    async function captureRequestHandler(): Promise<(request: unknown) => void> {
      const handlers: ((request: unknown) => void)[] = [];
      const page = {
        setRequestInterception: vi.fn().mockResolvedValue(undefined),
        on: vi.fn((event: string, fn: (request: unknown) => void) => {
          if (event === 'request') handlers.push(fn);
        }),
        goto: vi.fn().mockResolvedValue(undefined),
        // Bails out right after registration — no <video>, so it returns [].
        waitForSelector: vi.fn().mockRejectedValue(new Error('no <video> in this test')),
        close: vi.fn().mockResolvedValue(undefined),
      };
      puppeteer.launch.mockResolvedValue({
        newPage: vi.fn().mockResolvedValue(page),
        close: vi.fn().mockResolvedValue(undefined),
      });

      await extractBrowserFrames('https://example.com/video.mp4', '/tmp/out', { timestamps: [1] });

      expect(handlers).toHaveLength(1);
      return handlers[0];
    }

    function fakeRequest(url: string) {
      return {
        url: () => url,
        continue: vi.fn().mockResolvedValue(undefined),
        abort: vi.fn().mockResolvedValue(undefined),
      };
    }

    it.each([
      ['http://10.0.0.1/x.mp4', 'private literal'],
      ['http://169.254.169.254/latest/meta-data/', 'metadata'],
      ['http://[::ffff:a9fe:a9fe]/x.mp4', 'metadata as IPv4-mapped IPv6'],
      ['file:///etc/passwd', 'non-http scheme'],
      ['http://localhost:9000/x.mp4', 'localhost'],
    ])('aborts a %s subresource (%s)', async (url) => {
      const handler = await captureRequestHandler();
      const request = fakeRequest(url);

      handler(request);

      await vi.waitFor(() => expect(request.abort).toHaveBeenCalledWith('blockedbyclient'));
      expect(request.continue).not.toHaveBeenCalled();
    });

    it('aborts a hostname that only RESOLVES internal', async () => {
      // The case the literal check cannot see, and the reason this handler
      // resolves DNS instead of pattern-matching the hostname.
      const handler = await captureRequestHandler();
      dns.lookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
      const request = fakeRequest('http://internal.corp.example/x.mp4');

      handler(request);

      await vi.waitFor(() => expect(request.abort).toHaveBeenCalledWith('blockedbyclient'));
      expect(request.continue).not.toHaveBeenCalled();
    });

    it.each([
      ['https://cdn.example.com/segment.m4s', 'public subresource'],
      ['blob:https://example.com/8f0b-4c2a', 'MSE blob the <video> element needs'],
      ['data:image/gif;base64,R0lGOD', 'inline data URI'],
    ])('continues %s (%s)', async (url) => {
      const handler = await captureRequestHandler();
      const request = fakeRequest(url);

      handler(request);

      await vi.waitFor(() => expect(request.continue).toHaveBeenCalled());
      expect(request.abort).not.toHaveBeenCalled();
    });

    it('survives continue() rejecting on an already-handled request', async () => {
      // An unhandled rejection out of an event listener takes the process
      // down; puppeteer rejects here whenever the page navigated away first.
      const handler = await captureRequestHandler();
      const request = fakeRequest('https://cdn.example.com/segment.m4s');
      request.continue.mockRejectedValue(new Error('Request is already handled!'));

      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        handler(request);
        await vi.waitFor(() => expect(request.continue).toHaveBeenCalled());
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });
  });
});
