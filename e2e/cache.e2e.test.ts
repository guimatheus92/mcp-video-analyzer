import { describe, it, expect } from 'vitest';
import { AnalysisCache, cacheKey } from '../src/utils/cache.js';
import { filterAnalysisResult } from '../src/utils/field-filter.js';
import type { IAnalysisResult } from '../src/types.js';

function createResult(title = 'Test'): IAnalysisResult {
  return {
    metadata: {
      platform: 'direct',
      title,
      duration: 10,
      durationFormatted: '0:10',
      url: 'https://example.com/video.mp4',
    },
    transcript: [
      { time: '0:01', text: 'Hello' },
      { time: '0:05', text: 'World' },
    ],
    frames: [],
    comments: [],
    chapters: [],
    ocrResults: [],
    timeline: [],
    warnings: [],
  };
}

describe('E2E: Cache integration', () => {
  it('cache stores and retrieves full analysis result', () => {
    const cache = new AnalysisCache();
    const key = cacheKey('https://example.com/video.mp4', { detail: 'standard' });
    const result = createResult();

    cache.set(key, result);
    const cached = cache.get(key);

    expect(cached).toBeDefined();
    expect(cached?.metadata.title).toBe('Test');
    expect(cached?.transcript).toHaveLength(2);
  });

  it('second cache hit is instant (no re-processing)', () => {
    const cache = new AnalysisCache();
    const key = cacheKey('https://example.com/video.mp4');
    const result = createResult();

    cache.set(key, result);

    const start = performance.now();
    const cached = cache.get(key);
    const elapsed = performance.now() - start;

    expect(cached).toBeDefined();
    expect(elapsed).toBeLessThan(5); // sub-millisecond
  });

  it('different detail levels produce different cache keys', () => {
    const key1 = cacheKey('https://example.com/video.mp4', { detail: 'brief' });
    const key2 = cacheKey('https://example.com/video.mp4', { detail: 'standard' });
    const key3 = cacheKey('https://example.com/video.mp4', { detail: 'detailed' });

    expect(key1).not.toBe(key2);
    expect(key2).not.toBe(key3);
    expect(key1).not.toBe(key3);
  });

  it('field filter works on cached result', () => {
    const cache = new AnalysisCache();
    const key = cacheKey('https://example.com/video.mp4');
    const result = createResult();
    result.warnings.push('test warning');

    cache.set(key, result);
    const cached = cache.get(key)!;

    const filtered = filterAnalysisResult(cached, ['metadata']);
    expect(filtered.metadata).toBeDefined();
    expect(filtered.transcript).toBeUndefined();
    expect(filtered.warnings).toEqual(['test warning']); // always included
  });

  it('forceRefresh: new value overwrites cached', () => {
    const cache = new AnalysisCache();
    const key = cacheKey('https://example.com/video.mp4');

    cache.set(key, createResult('Original'));
    expect(cache.get(key)?.metadata.title).toBe('Original');

    // Simulate forceRefresh: overwrite with new result
    cache.set(key, createResult('Refreshed'));
    expect(cache.get(key)?.metadata.title).toBe('Refreshed');
  });

  it('eviction works under pressure', () => {
    const cache = new AnalysisCache({ maxEntries: 3 });

    cache.set('a', createResult('A'));
    cache.set('b', createResult('B'));
    cache.set('c', createResult('C'));
    cache.set('d', createResult('D')); // evicts 'a'

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('d')?.metadata.title).toBe('D');
    expect(cache.stats().size).toBe(3);
  });
});
