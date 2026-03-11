import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '../utils/temp-files.js';
import { DirectAdapter } from './direct.adapter.js';

describe('DirectAdapter', () => {
  const adapter = new DirectAdapter();
  const originalFetch = globalThis.fetch;
  const dirsToClean: string[] = [];

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    for (const dir of dirsToClean) {
      await cleanupTempDir(dir).catch(() => undefined);
    }
    dirsToClean.length = 0;
  });

  describe('canHandle', () => {
    it('returns true for .mp4 URLs', () => {
      expect(adapter.canHandle('https://example.com/video.mp4')).toBe(true);
    });

    it('returns true for .webm URLs', () => {
      expect(adapter.canHandle('https://example.com/video.webm')).toBe(true);
    });

    it('returns true for .mov URLs', () => {
      expect(adapter.canHandle('https://example.com/clip.mov')).toBe(true);
    });

    it('returns false for HTML pages', () => {
      expect(adapter.canHandle('https://example.com/page.html')).toBe(false);
    });

    it('returns false for Loom URLs', () => {
      expect(adapter.canHandle('https://www.loom.com/share/abc123')).toBe(false);
    });
  });

  describe('getMetadata', () => {
    it('returns URL-based title', async () => {
      const metadata = await adapter.getMetadata('https://example.com/demo.mp4');
      expect(metadata.platform).toBe('direct');
      expect(metadata.title).toBe('demo.mp4');
      expect(metadata.duration).toBe(0);
    });
  });

  describe('getTranscript', () => {
    it('returns empty array', async () => {
      expect(await adapter.getTranscript('https://example.com/video.mp4')).toEqual([]);
    });
  });

  describe('getComments', () => {
    it('returns empty array', async () => {
      expect(await adapter.getComments('https://example.com/video.mp4')).toEqual([]);
    });
  });

  describe('downloadVideo', () => {
    it('downloads video to destination directory', async () => {
      const testContent = Buffer.from('fake video content');
      const readableStream = new ReadableStream({
        start(controller) {
          controller.enqueue(testContent);
          controller.close();
        },
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: readableStream,
      });

      const tempDir = await createTempDir();
      dirsToClean.push(tempDir);

      const result = await adapter.downloadVideo('https://example.com/demo.mp4', tempDir);

      expect(result).not.toBeNull();
      expect(existsSync(result as string)).toBe(true);
      expect(readFileSync(result as string).toString()).toBe('fake video content');
    });

    it('returns null when fetch fails', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

      const tempDir = await createTempDir();
      dirsToClean.push(tempDir);

      const result = await adapter.downloadVideo('https://example.com/video.mp4', tempDir);
      expect(result).toBeNull();
    });
  });
});
