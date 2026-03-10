import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnalysisCache, cacheKey } from './cache.js';
import type { IAnalysisResult } from '../types.js';

function createMockResult(title = 'Test Video'): IAnalysisResult {
  return {
    metadata: {
      platform: 'loom',
      title,
      duration: 120,
      durationFormatted: '2:00',
      url: 'https://www.loom.com/share/test123',
    },
    transcript: [{ time: '0:05', text: 'Hello world' }],
    frames: [],
    comments: [],
    chapters: [],
    ocrResults: [],
    timeline: [],
    warnings: [],
  };
}

describe('AnalysisCache', () => {
  let cache: AnalysisCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new AnalysisCache({ ttlMs: 10_000, maxEntries: 3 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves a value', () => {
    const result = createMockResult();
    cache.set('key1', result);
    expect(cache.get('key1')).toEqual(result);
  });

  it('returns undefined for missing keys', () => {
    expect(cache.get('nonexistent')).toBeUndefined();
  });

  it('expires entries after TTL', () => {
    cache.set('key1', createMockResult());
    expect(cache.get('key1')).toBeDefined();

    vi.advanceTimersByTime(10_001);
    expect(cache.get('key1')).toBeUndefined();
  });

  it('has() respects TTL', () => {
    cache.set('key1', createMockResult());
    expect(cache.has('key1')).toBe(true);

    vi.advanceTimersByTime(10_001);
    expect(cache.has('key1')).toBe(false);
  });

  it('has() returns false for missing keys', () => {
    expect(cache.has('nonexistent')).toBe(false);
  });

  it('evicts oldest entry when maxEntries reached', () => {
    cache.set('key1', createMockResult('Video 1'));
    vi.advanceTimersByTime(1);
    cache.set('key2', createMockResult('Video 2'));
    vi.advanceTimersByTime(1);
    cache.set('key3', createMockResult('Video 3'));
    vi.advanceTimersByTime(1);

    // Adding a 4th should evict key1 (oldest)
    cache.set('key4', createMockResult('Video 4'));

    expect(cache.get('key1')).toBeUndefined();
    expect(cache.get('key2')).toBeDefined();
    expect(cache.get('key3')).toBeDefined();
    expect(cache.get('key4')).toBeDefined();
  });

  it('does not evict when updating existing key', () => {
    cache.set('key1', createMockResult('Video 1'));
    cache.set('key2', createMockResult('Video 2'));
    cache.set('key3', createMockResult('Video 3'));

    // Updating key1 should not evict anything
    cache.set('key1', createMockResult('Video 1 Updated'));

    expect(cache.get('key1')?.metadata.title).toBe('Video 1 Updated');
    expect(cache.get('key2')).toBeDefined();
    expect(cache.get('key3')).toBeDefined();
  });

  it('tracks hit and miss stats', () => {
    cache.set('key1', createMockResult());

    cache.get('key1'); // hit
    cache.get('key1'); // hit
    cache.get('missing'); // miss

    const stats = cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.size).toBe(1);
  });

  it('counts expired lookups as misses', () => {
    cache.set('key1', createMockResult());
    vi.advanceTimersByTime(10_001);

    cache.get('key1'); // miss (expired)

    expect(cache.stats().misses).toBe(1);
    expect(cache.stats().hits).toBe(0);
  });

  it('clear() resets everything', () => {
    cache.set('key1', createMockResult());
    cache.get('key1'); // hit

    cache.clear();

    expect(cache.stats()).toEqual({ size: 0, hits: 0, misses: 0 });
    expect(cache.get('key1')).toBeUndefined(); // miss after clear
  });

  it('uses default options when none provided', () => {
    const defaultCache = new AnalysisCache();
    defaultCache.set('key1', createMockResult());
    expect(defaultCache.get('key1')).toBeDefined();
  });
});

describe('cacheKey', () => {
  it('returns a deterministic hex string', () => {
    const key1 = cacheKey('https://example.com/video.mp4');
    const key2 = cacheKey('https://example.com/video.mp4');
    expect(key1).toBe(key2);
    expect(key1).toHaveLength(16);
    expect(key1).toMatch(/^[a-f0-9]{16}$/);
  });

  it('produces different keys for different URLs', () => {
    const key1 = cacheKey('https://example.com/video1.mp4');
    const key2 = cacheKey('https://example.com/video2.mp4');
    expect(key1).not.toBe(key2);
  });

  it('produces different keys for different params', () => {
    const key1 = cacheKey('https://example.com/video.mp4', { detail: 'brief' });
    const key2 = cacheKey('https://example.com/video.mp4', { detail: 'detailed' });
    expect(key1).not.toBe(key2);
  });

  it('produces same key regardless of param order', () => {
    const key1 = cacheKey('https://example.com/video.mp4', { a: 1, b: 2 });
    const key2 = cacheKey('https://example.com/video.mp4', { b: 2, a: 1 });
    expect(key1).toBe(key2);
  });

  it('handles URL without params', () => {
    const key = cacheKey('https://example.com/video.mp4');
    expect(key).toHaveLength(16);
  });
});
