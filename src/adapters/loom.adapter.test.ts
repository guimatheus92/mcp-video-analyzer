import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURES_DIR } from '../../test/helpers/index.js';
import { LoomAdapter } from './loom.adapter.js';

// Mock child_process so findYtDlp resolves instantly (no real exec calls)
vi.mock('node:child_process', () => ({
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb?: (...args: unknown[]) => void) => {
    if (typeof _opts === 'function') {
      (_opts as (...args: unknown[]) => void)(new Error('not found'), '', '');
    } else if (typeof cb === 'function') {
      cb(new Error('not found'), '', '');
    }
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
  });
});
