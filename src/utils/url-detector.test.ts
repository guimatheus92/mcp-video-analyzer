import { describe, expect, it } from 'vitest';
import { detectPlatform, extractLoomId, isVideoSource, toLocalPath } from './url-detector.js';

describe('detectPlatform', () => {
  it('detects Loom share URLs', () => {
    expect(detectPlatform('https://www.loom.com/share/abc123def456')).toBe('loom');
  });

  it('detects Loom share URLs without www', () => {
    expect(detectPlatform('https://loom.com/share/abc123def456')).toBe('loom');
  });

  it('detects Loom embed URLs', () => {
    expect(detectPlatform('https://www.loom.com/embed/abc123def456')).toBe('loom');
  });

  it('detects Loom URLs with query params', () => {
    expect(detectPlatform('https://www.loom.com/share/abc123?sid=xyz')).toBe('loom');
  });

  it('detects direct .mp4 URLs', () => {
    expect(detectPlatform('https://example.com/video.mp4')).toBe('direct');
  });

  it('detects direct .webm URLs', () => {
    expect(detectPlatform('https://example.com/video.webm')).toBe('direct');
  });

  it('detects direct .mov URLs', () => {
    expect(detectPlatform('https://example.com/video.mov')).toBe('direct');
  });

  it('detects direct .avi URLs', () => {
    expect(detectPlatform('https://example.com/video.avi')).toBe('direct');
  });

  it('detects direct .mkv URLs', () => {
    expect(detectPlatform('https://example.com/video.mkv')).toBe('direct');
  });

  it('detects direct .m4v URLs', () => {
    expect(detectPlatform('https://example.com/video.m4v')).toBe('direct');
  });

  it('returns null for YouTube URLs (unsupported in v0.1)', () => {
    expect(detectPlatform('https://www.youtube.com/watch?v=abc123')).toBeNull();
  });

  it('returns null for youtu.be URLs (unsupported in v0.1)', () => {
    expect(detectPlatform('https://youtu.be/abc123')).toBeNull();
  });

  it('returns null for HTML pages', () => {
    expect(detectPlatform('https://example.com/page.html')).toBeNull();
  });

  it('returns null for non-video URLs', () => {
    expect(detectPlatform('https://example.com/some-page')).toBeNull();
  });

  it('returns null for invalid URLs', () => {
    expect(detectPlatform('not-a-url')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(detectPlatform('')).toBeNull();
  });

  it('handles case-insensitive extensions', () => {
    expect(detectPlatform('https://example.com/VIDEO.MP4')).toBe('direct');
  });

  it('detects absolute POSIX paths to video files as local', () => {
    expect(detectPlatform('/Users/me/Movies/clip.mp4')).toBe('local');
    expect(detectPlatform('/tmp/video.webm')).toBe('local');
  });

  it('detects file:// URIs as local', () => {
    expect(detectPlatform('file:///Users/me/Movies/clip.mp4')).toBe('local');
    expect(detectPlatform('file:///tmp/video.mov')).toBe('local');
  });

  it('returns null for absolute paths that are not video files', () => {
    expect(detectPlatform('/Users/me/notes.txt')).toBeNull();
    expect(detectPlatform('/tmp/page.html')).toBeNull();
  });

  it('returns null for relative paths', () => {
    expect(detectPlatform('./video.mp4')).toBeNull();
    expect(detectPlatform('video.mp4')).toBeNull();
    expect(detectPlatform('../movies/clip.mp4')).toBeNull();
  });
});

describe('toLocalPath', () => {
  it('returns the path unchanged for absolute POSIX paths', () => {
    expect(toLocalPath('/tmp/video.mp4')).toBe('/tmp/video.mp4');
  });

  it('converts file:// URIs to fs paths', () => {
    expect(toLocalPath('file:///tmp/video.mp4')).toBe('/tmp/video.mp4');
  });

  it('returns null for HTTP URLs', () => {
    expect(toLocalPath('https://example.com/video.mp4')).toBeNull();
  });

  it('returns null for relative paths', () => {
    expect(toLocalPath('./video.mp4')).toBeNull();
    expect(toLocalPath('video.mp4')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(toLocalPath('')).toBeNull();
  });
});

describe('isVideoSource', () => {
  it('accepts Loom URLs', () => {
    expect(isVideoSource('https://loom.com/share/abc123')).toBe(true);
  });

  it('accepts direct video URLs', () => {
    expect(isVideoSource('https://example.com/video.mp4')).toBe(true);
  });

  it('accepts absolute paths to video files', () => {
    expect(isVideoSource('/tmp/video.mp4')).toBe(true);
  });

  it('accepts file:// URIs to video files', () => {
    expect(isVideoSource('file:///tmp/video.mp4')).toBe(true);
  });

  it('rejects relative paths', () => {
    expect(isVideoSource('./video.mp4')).toBe(false);
  });

  it('rejects non-video URLs', () => {
    expect(isVideoSource('https://example.com/page.html')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isVideoSource('')).toBe(false);
  });
});

describe('extractLoomId', () => {
  it('extracts ID from share URL', () => {
    expect(extractLoomId('https://www.loom.com/share/abc123def456')).toBe('abc123def456');
  });

  it('extracts ID from embed URL', () => {
    expect(extractLoomId('https://www.loom.com/embed/abc123def456')).toBe('abc123def456');
  });

  it('extracts ID without query params polluting it', () => {
    expect(extractLoomId('https://www.loom.com/share/abc123def456?sid=xyz')).toBe('abc123def456');
  });

  it('extracts UUID-style IDs', () => {
    expect(extractLoomId('https://www.loom.com/share/a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    );
  });

  it('returns null for non-Loom URLs', () => {
    expect(extractLoomId('https://example.com/video.mp4')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractLoomId('')).toBeNull();
  });

  it('returns null for Loom URLs without share/embed path', () => {
    expect(extractLoomId('https://www.loom.com/pricing')).toBeNull();
  });
});
