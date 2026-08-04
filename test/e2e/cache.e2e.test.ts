import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAdapters, registerAdapter } from '../../src/adapters/adapter.interface.js';
import { LocalFileAdapter } from '../../src/adapters/local-file.adapter.js';
import { getAnalysis, resolveAnalyzeParams } from '../../src/tools/analyze-core.js';
import type { IAnalysisResult } from '../../src/types.js';
import { AnalysisCache, cacheKey } from '../../src/utils/cache.js';
import { filterAnalysisResult } from '../../src/utils/field-filter.js';
import { cleanupTempDir, createTempDir } from '../../src/utils/temp-files.js';
import { sceneCutClip } from '../helpers/index.js';

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
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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

describe('E2E: skipFrames keys the analysis cache (issue #29, real ffmpeg)', () => {
  beforeAll(() => {
    clearAdapters();
    registerAdapter(new LocalFileAdapter());
  });

  afterAll(() => {
    clearAdapters();
  });

  beforeEach(() => {
    // Never persist sidecars next to the shared cached golden clip, and pin
    // the width env so ambient config can't perturb the key under test.
    vi.stubEnv('MCP_WRITE_SIDECARS', '');
    vi.stubEnv('MCP_FRAME_MAX_WIDTH', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The issue #29 repro, pinned through the real getAnalysis pipeline: a
  // frameless analysis cached first must not answer a later framed call for
  // the same file. Pre-fix both hashed to one key, so the second call served
  // the cached zero-frame result — this test's framed call asserts recovered
  // content (empty = FAIL), per the golden-fixture convention.
  it('a framed call after a skipFrames call re-runs the pipeline and yields frames', async () => {
    const clip = await sceneCutClip();

    const frameless = await getAnalysis(
      clip,
      resolveAnalyzeParams({ skipFrames: true, forceRefresh: true }),
    );
    try {
      expect(frameless.result.frames).toHaveLength(0);
    } finally {
      await frameless.cleanup();
    }

    const framed = await getAnalysis(clip, resolveAnalyzeParams({}));
    try {
      expect(framed.result.frames.length).toBeGreaterThan(0);
    } finally {
      await framed.cleanup();
    }
  });

  // Pins the `|| undefined` normalization in resultDefiningParams(), which no
  // other test reaches through the real pipeline: a framed run must persist a
  // sidecar whose params OMIT skipFrames (the canonical framed shape), and an
  // explicit skipFrames: false call must key identically to an omitted one.
  // Dropping `|| undefined` puts `"skipFrames":false` in the persisted params
  // and fails the shape assertion.
  it('persists the canonical framed shape and keys explicit skipFrames:false identically', async () => {
    vi.stubEnv('MCP_WRITE_SIDECARS', '1');
    const tempDir = await createTempDir('key-shape-');
    try {
      const clip = join(tempDir, 'clip.mp4');
      await copyFile(await sceneCutClip(), clip);

      clearAdapters();
      const adapter = new LocalFileAdapter();
      const getMetadata = vi.spyOn(adapter, 'getMetadata');
      registerAdapter(adapter);

      const framed = await getAnalysis(clip, resolveAnalyzeParams({ forceRefresh: true }));
      try {
        expect(framed.result.frames.length).toBeGreaterThan(0);
      } finally {
        await framed.cleanup();
      }

      const persisted = JSON.parse(await readFile(join(tempDir, 'clip.analysis.json'), 'utf8'));
      expect(persisted.params).not.toHaveProperty('skipFrames');

      // Explicit false ≡ omitted: same key, so this is served from cache.
      const explicit = await getAnalysis(clip, resolveAnalyzeParams({ skipFrames: false }));
      await explicit.cleanup();
      expect(getMetadata).toHaveBeenCalledTimes(1);
    } finally {
      await cleanupTempDir(tempDir);
    }
  });
});
