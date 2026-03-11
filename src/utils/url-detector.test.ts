import { describe, expect, it } from 'vitest';
import { detectPlatform, extractLoomId } from './url-detector.js';

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
