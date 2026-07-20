import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURES_DIR } from '../../test/helpers/index.js';
import { cleanupTempDir, createTempDir } from '../utils/temp-files.js';
import { resetYtDlpLocator } from '../utils/ytdlp.js';
import { LoomAdapter, extensionFromContentType } from './loom.adapter.js';

// Per-test yt-dlp behaviour. Default: absent, so findYtDlp resolves instantly
// with no real exec calls. Tests that need a working yt-dlp reassign it.
let execHandler: (cmd: string, args: string[]) => Error | null = () => new Error('not found');

vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb?: (...args: unknown[]) => void) => {
    const callback = (typeof _opts === 'function' ? _opts : cb) as
      | ((...args: unknown[]) => void)
      | undefined;
    callback?.(execHandler(cmd, args), '', '');
  },
}));

const metadataFixture = JSON.parse(
  readFileSync(join(FIXTURES_DIR, 'loom-graphql-metadata.json'), 'utf-8'),
);
const transcriptFixture = JSON.parse(
  readFileSync(join(FIXTURES_DIR, 'loom-graphql-transcript.json'), 'utf-8'),
);
const commentsFixture = JSON.parse(
  readFileSync(join(FIXTURES_DIR, 'loom-graphql-comments.json'), 'utf-8'),
);
const sampleVtt = readFileSync(join(FIXTURES_DIR, 'sample.vtt'), 'utf-8');

describe('LoomAdapter', () => {
  let adapter: LoomAdapter;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    adapter = new LoomAdapter();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('canHandle', () => {
    it('returns true for loom.com share URLs', () => {
      expect(adapter.canHandle('https://www.loom.com/share/abc123')).toBe(true);
    });

    it('returns true for loom.com embed URLs', () => {
      expect(adapter.canHandle('https://www.loom.com/embed/abc123')).toBe(true);
    });

    it('returns false for non-loom URLs', () => {
      expect(adapter.canHandle('https://youtube.com/watch?v=abc')).toBe(false);
    });

    it('returns false for direct video URLs', () => {
      expect(adapter.canHandle('https://example.com/video.mp4')).toBe(false);
    });
  });

  describe('getMetadata', () => {
    it('returns metadata from GraphQL response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(metadataFixture),
      });

      const metadata = await adapter.getMetadata('https://www.loom.com/share/abc123def456');

      expect(metadata.platform).toBe('loom');
      expect(metadata.title).toBe('Bug: Cart total not updating');
      expect(metadata.description).toBe('Demonstrating the cart total bug on the checkout page');
      expect(metadata.duration).toBe(154.5);
      expect(metadata.durationFormatted).toBe('2:34');
    });

    it('returns default title when GraphQL fails', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      const metadata = await adapter.getMetadata('https://www.loom.com/share/abc123');
      expect(metadata.title).toBe('Untitled Loom Video');
      expect(metadata.duration).toBe(0);
    });
  });

  describe('getTranscript', () => {
    it('fetches VTT and parses transcript entries', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // GraphQL call
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(transcriptFixture),
          });
        }
        // VTT fetch
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(sampleVtt),
        });
      });

      const entries = await adapter.getTranscript('https://www.loom.com/share/abc123def456');

      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0].time).toBe('0:05');
      expect(entries[0].text).toContain('add to cart');
    });

    it('returns empty array when GraphQL fails', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      const entries = await adapter.getTranscript('https://www.loom.com/share/abc123');
      expect(entries).toEqual([]);
    });

    it('returns empty array when no captions URL', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: { fetchVideoTranscript: { captions_source_url: null } },
          }),
      });

      const entries = await adapter.getTranscript('https://www.loom.com/share/abc123');
      expect(entries).toEqual([]);
    });
  });

  describe('getComments', () => {
    it('parses comments including nested replies', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(commentsFixture),
      });

      const comments = await adapter.getComments('https://www.loom.com/share/abc123def456');

      expect(comments).toHaveLength(3); // 1 parent + 1 reply + 1 standalone
      expect(comments[0].author).toBe('John');
      expect(comments[0].text).toBe('This also happens on mobile');
      expect(comments[0].time).toBe('0:12');
      expect(comments[1].author).toBe('Sarah');
      expect(comments[1].text).toBe('Confirmed on iOS Safari too');
      expect(comments[2].author).toBe('Dev');
      expect(comments[2].text).toBe('Fixed in PR #234');
    });

    it('returns empty array when GraphQL fails', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      const comments = await adapter.getComments('https://www.loom.com/share/abc123');
      expect(comments).toEqual([]);
    });
  });

  describe('downloadVideo', () => {
    it('returns null when yt-dlp is not available', async () => {
      // downloadVideo calls findYtDlp which tries execFile for yt-dlp binaries.
      // When none are found, it returns null. If yt-dlp IS installed,
      // it still returns null because the dest dir doesn't exist.
      const result = await adapter.downloadVideo(
        'https://www.loom.com/share/abc123',
        '/tmp/nonexistent',
      );
      expect(result).toBeNull();
    });

    // Issue #24 was invisible because this path returned null with no warning:
    // the user saw "no frames" and was told to install yt-dlp they already had.
    it('always explains why it returned null', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

      const warnings: string[] = [];
      const result = await adapter.downloadVideo(
        'https://www.loom.com/share/abc123',
        '/tmp/nonexistent',
        (w) => warnings.push(w),
      );

      expect(result).toBeNull();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Loom video download failed');
      // Both strategies must account for themselves: the yt-dlp reason comes
      // from the delegated adapter, the CDN one from the 204-no-body response
      // (204 is `ok`, so response.json() throws on the empty body).
      expect(warnings[0]).toContain('yt-dlp is not installed');
      expect(warnings[0]).toMatch(/CDN URL lookup failed|no downloadable CDN URL/);
    });

    // The headline fix. Every other Loom download test runs with yt-dlp
    // absent, so without this the delegation wiring itself is only covered by
    // a network-dependent e2e that is allowed to skip — dropping the early
    // return would pass the entire unit suite.
    it('returns the delegate’s merged file and skips the CDN strategy', async () => {
      resetYtDlpLocator();
      const tempDir = await createTempDir();
      try {
        execHandler = (_cmd, args) => {
          if (args.includes('--version')) return null;
          const template = args[args.indexOf('-o') + 1];
          // Loom's DASH merge lands as webm, not mp4.
          writeFileSync(template.replace('%(ext)s', 'webm'), 'merged');
          return null;
        };
        const fetchSpy = vi.fn();
        globalThis.fetch = fetchSpy;

        const warnings: string[] = [];
        const result = await adapter.downloadVideo(
          'https://www.loom.com/share/abc123',
          tempDir,
          (w) => warnings.push(w),
        );

        expect(result).toBe(join(tempDir, 'video.webm'));
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(warnings).toEqual([]);
      } finally {
        execHandler = () => new Error('not found');
        resetYtDlpLocator();
        await cleanupTempDir(tempDir);
      }
    });

    // A degraded-but-working yt-dlp setup must stay visible on Loom, exactly
    // as it is on every other platform.
    it('forwards non-fatal delegate warnings even when the download succeeds', async () => {
      resetYtDlpLocator();
      vi.stubEnv('YTDLP_COOKIES_FROM_BROWSER', 'edge');
      const tempDir = await createTempDir();
      try {
        execHandler = (_cmd, args) => {
          if (args.includes('--version')) return null;
          if (args.includes('--cookies-from-browser')) {
            return Object.assign(new Error('Command failed'), {
              stderr: 'ERROR: could not find edge cookies database\n',
            });
          }
          writeFileSync(args[args.indexOf('-o') + 1].replace('%(ext)s', 'webm'), 'merged');
          return null;
        };

        const warnings: string[] = [];
        const result = await adapter.downloadVideo(
          'https://www.loom.com/share/abc123',
          tempDir,
          (w) => warnings.push(w),
        );

        expect(result).toBe(join(tempDir, 'video.webm'));
        expect(warnings.join(' ')).toContain('Cookie source unusable');
      } finally {
        execHandler = () => new Error('not found');
        resetYtDlpLocator();
        await cleanupTempDir(tempDir);
      }
    });

    // Every other test here asserts toBeNull(), so the branch that actually
    // returns a CDN path never ran — an inverted condition or a lost `return`
    // in the Strategy 2 rewrite would have shipped green.
    it('falls back to the Loom CDN when yt-dlp is unavailable', async () => {
      const tempDir = await createTempDir();
      try {
        globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
          const target = String(input);
          if (target.includes('transcoded-url')) {
            return new Response(JSON.stringify({ url: 'https://cdn.loom.test/v.mp4' }), {
              status: 200,
            });
          }
          return new Response('video-bytes', { status: 200 });
        }) as typeof fetch;

        const warnings: string[] = [];
        const result = await adapter.downloadVideo(
          'https://www.loom.com/share/abc123',
          tempDir,
          (w) => warnings.push(w),
        );

        expect(result).toBe(join(tempDir, 'abc123.mp4'));
        expect(statSync(result as string).size).toBeGreaterThan(0);
      } finally {
        await cleanupTempDir(tempDir);
      }
    });

    // Assuming `.mp4` on the fallback path would repeat, one branch over, the
    // assumption that caused issue #24 on the yt-dlp path.
    it('names the CDN file after the container the CDN actually sent', async () => {
      const tempDir = await createTempDir();
      try {
        globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
          const target = String(input);
          if (target.includes('transcoded-url')) {
            return new Response(JSON.stringify({ url: 'https://cdn.loom.test/v' }), {
              status: 200,
            });
          }
          return new Response('video-bytes', {
            status: 200,
            headers: { 'content-type': 'video/webm' },
          });
        }) as typeof fetch;

        const result = await adapter.downloadVideo('https://www.loom.com/share/abc123', tempDir);
        expect(result).toBe(join(tempDir, 'abc123.webm'));
      } finally {
        await cleanupTempDir(tempDir);
      }
    });

    // createWriteStream creates the file on open, so an empty body used to
    // look like a successful download and yielded zero frames downstream.
    it('rejects an empty CDN body instead of returning a 0-byte file', async () => {
      const tempDir = await createTempDir();
      try {
        globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
          const target = String(input);
          if (target.includes('transcoded-url')) {
            return new Response(JSON.stringify({ url: 'https://cdn.loom.test/v.mp4' }), {
              status: 200,
            });
          }
          return new Response('', { status: 200 });
        }) as typeof fetch;

        const warnings: string[] = [];
        const result = await adapter.downloadVideo(
          'https://www.loom.com/share/abc123',
          tempDir,
          (w) => warnings.push(w),
        );

        expect(result).toBeNull();
        expect(warnings.join(' ')).toContain('empty body');
      } finally {
        await cleanupTempDir(tempDir);
      }
    });

    it('reports the CDN status when Loom answers non-OK', async () => {
      const tempDir = await createTempDir();
      try {
        globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
          const target = String(input);
          if (target.includes('transcoded-url')) {
            return new Response(JSON.stringify({ url: 'https://cdn.loom.test/v.mp4' }), {
              status: 200,
            });
          }
          return new Response('nope', { status: 403 });
        }) as typeof fetch;

        const warnings: string[] = [];
        const result = await adapter.downloadVideo(
          'https://www.loom.com/share/abc123',
          tempDir,
          (w) => warnings.push(w),
        );

        expect(result).toBeNull();
        expect(warnings.join(' ')).toContain('HTTP 403');
      } finally {
        await cleanupTempDir(tempDir);
      }
    });

    // analyze-core.ts calls downloadVideo without a .catch — a rejection here
    // would take down the whole analysis instead of degrading to warnings.
    it('never rejects, even when the network throws', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('socket hang up'));

      const warnings: string[] = [];
      await expect(
        adapter.downloadVideo('https://www.loom.com/share/abc123', '/tmp/nonexistent', (w) =>
          warnings.push(w),
        ),
      ).resolves.toBeNull();
      expect(warnings.join(' ')).toContain('Loom video download failed');
    });
  });
});

describe('extensionFromContentType', () => {
  it.each([
    ['video/webm', 'webm'],
    ['video/webm; codecs="vp9,opus"', 'webm'],
    ['video/x-matroska', 'mkv'],
    ['video/quicktime', 'mov'],
    ['video/mp4', 'mp4'],
  ])('maps %s to .%s', (contentType, expected) => {
    expect(extensionFromContentType(contentType)).toBe(expected);
  });

  it.each([null, '', 'application/octet-stream'])('defaults to mp4 for %j', (contentType) => {
    expect(extensionFromContentType(contentType)).toBe('mp4');
  });
});
