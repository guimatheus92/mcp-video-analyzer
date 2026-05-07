import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFileAdapter } from './local-file.adapter.js';

describe('LocalFileAdapter', () => {
  const adapter = new LocalFileAdapter();
  let tmp: string;
  let videoPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'local-adapter-'));
    videoPath = join(tmp, 'demo.mp4');
    writeFileSync(videoPath, 'fake video bytes');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('canHandle', () => {
    it('returns true for absolute paths to video files', () => {
      expect(adapter.canHandle(videoPath)).toBe(true);
    });

    it('returns true for file:// URIs to video files', () => {
      expect(adapter.canHandle(pathToFileURL(videoPath).href)).toBe(true);
    });

    it('returns false for HTTP URLs', () => {
      expect(adapter.canHandle('https://example.com/video.mp4')).toBe(false);
    });

    it('returns false for Loom URLs', () => {
      expect(adapter.canHandle('https://www.loom.com/share/abc123')).toBe(false);
    });

    it('returns false for relative paths', () => {
      expect(adapter.canHandle('./video.mp4')).toBe(false);
    });

    it('returns false for absolute paths to non-video files', () => {
      expect(adapter.canHandle('/tmp/notes.txt')).toBe(false);
    });
  });

  describe('getMetadata', () => {
    it('returns basename as title and platform="local"', async () => {
      const metadata = await adapter.getMetadata(videoPath);
      expect(metadata.platform).toBe('local');
      expect(metadata.title).toBe('demo.mp4');
      expect(metadata.url).toBe(videoPath);
    });

    it('handles file:// URIs', async () => {
      const fileUri = pathToFileURL(videoPath).href;
      const metadata = await adapter.getMetadata(fileUri);
      expect(metadata.title).toBe('demo.mp4');
      expect(metadata.url).toBe(fileUri);
    });

    it('reports file size from stat', async () => {
      const metadata = await adapter.getMetadata(videoPath);
      expect(metadata.fileSizeBytes).toBe('fake video bytes'.length);
    });

    it('falls back to duration=0 when ffmpeg cannot probe (corrupt content)', async () => {
      // The fake "video" written above isn't a valid container — probe fails
      // gracefully and we still get a sensible metadata object.
      const metadata = await adapter.getMetadata(videoPath);
      expect(metadata.duration).toBe(0);
      expect(metadata.durationFormatted).toBe('0:00');
    });
  });

  describe('getTranscript / getComments / getChapters / getAiSummary', () => {
    it('all return empty/null', async () => {
      expect(await adapter.getTranscript(videoPath)).toEqual([]);
      expect(await adapter.getComments(videoPath)).toEqual([]);
      expect(await adapter.getChapters(videoPath)).toEqual([]);
      expect(await adapter.getAiSummary(videoPath)).toBeNull();
    });
  });

  describe('downloadVideo', () => {
    it('returns the path as-is for an absolute path', async () => {
      const result = await adapter.downloadVideo(videoPath, tmp);
      expect(result).toBe(videoPath);
    });

    it('resolves file:// URIs to fs paths', async () => {
      const result = await adapter.downloadVideo(pathToFileURL(videoPath).href, tmp);
      expect(result).toBe(videoPath);
    });

    it('throws UserError when the file does not exist', async () => {
      await expect(adapter.downloadVideo('/tmp/does-not-exist-xyz.mp4', tmp)).rejects.toThrow(
        /not found/i,
      );
    });

    it('throws UserError when the path is a directory', async () => {
      const dir = join(tmp, 'subdir.mp4');
      mkdirSync(dir);
      await expect(adapter.downloadVideo(dir, tmp)).rejects.toThrow(/not a regular file/i);
    });
  });
});
