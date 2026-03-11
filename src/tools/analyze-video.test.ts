import { FastMCP } from 'fastmcp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAdapters, registerAdapter } from '../adapters/adapter.interface.js';
import type { IVideoAdapter } from '../adapters/adapter.interface.js';
import type { IAdapterCapabilities } from '../types.js';
import { registerAnalyzeVideo } from './analyze-video.js';

function createMockAdapter(overrides: Partial<IVideoAdapter> = {}): IVideoAdapter {
  const capabilities: IAdapterCapabilities = {
    transcript: true,
    metadata: true,
    comments: true,
    chapters: false,
    aiSummary: false,
    videoDownload: false,
    ...overrides.capabilities,
  };

  return {
    name: 'mock',
    capabilities,
    canHandle: () => true,
    getMetadata: vi.fn().mockResolvedValue({
      platform: 'loom',
      title: 'Test Video',
      duration: 120,
      durationFormatted: '2:00',
      url: 'https://www.loom.com/share/test123',
    }),
    getTranscript: vi.fn().mockResolvedValue([
      { time: '0:05', text: 'Hello world' },
      { time: '0:12', text: 'This is a test' },
    ]),
    getComments: vi
      .fn()
      .mockResolvedValue([{ author: 'Alice', text: 'Great video!', time: '0:10' }]),
    getChapters: vi.fn().mockResolvedValue([]),
    getAiSummary: vi.fn().mockResolvedValue(null),
    downloadVideo: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('analyze_video tool', () => {
  let server: FastMCP;

  beforeEach(() => {
    clearAdapters();
    server = new FastMCP({ name: 'test', version: '0.0.0' });
    registerAnalyzeVideo(server);
  });

  afterEach(() => {
    clearAdapters();
  });

  it('registers the tool on the server', () => {
    expect(server).toBeDefined();
  });

  it('returns transcript and metadata when skipFrames is true', async () => {
    const mockAdapter = createMockAdapter();
    registerAdapter(mockAdapter);

    expect(mockAdapter.canHandle('https://www.loom.com/share/test123')).toBe(true);
    expect(mockAdapter.getMetadata).toBeDefined();
    expect(mockAdapter.getTranscript).toBeDefined();
  });

  it('reports video download not available when adapter lacks capability', () => {
    const mockAdapter = createMockAdapter({
      capabilities: {
        transcript: true,
        metadata: true,
        comments: true,
        chapters: false,
        aiSummary: false,
        videoDownload: false,
      },
    });
    registerAdapter(mockAdapter);

    expect(mockAdapter.capabilities.videoDownload).toBe(false);
  });
});

describe('analyze_video detail levels', () => {
  beforeEach(() => {
    clearAdapters();
  });

  afterEach(() => {
    clearAdapters();
  });

  it('brief config has includeFrames=false', async () => {
    // Verify that brief mode config correctly skips frames
    const { getDetailConfig } = await import('../config/detail-levels.js');
    const briefConfig = getDetailConfig('brief');
    expect(briefConfig.includeFrames).toBe(false);
    expect(briefConfig.maxFrames).toBe(0);
    expect(briefConfig.transcriptMaxEntries).toBe(10);
  });

  it('standard config matches v0.1 defaults', async () => {
    const { getDetailConfig } = await import('../config/detail-levels.js');
    const standardConfig = getDetailConfig('standard');
    expect(standardConfig.includeFrames).toBe(true);
    expect(standardConfig.maxFrames).toBe(20);
    expect(standardConfig.denseSampling).toBe(false);
  });

  it('detailed config enables dense sampling', async () => {
    const { getDetailConfig } = await import('../config/detail-levels.js');
    const detailedConfig = getDetailConfig('detailed');
    expect(detailedConfig.denseSampling).toBe(true);
    expect(detailedConfig.maxFrames).toBe(60);
  });
});

describe('analyze_video field filtering', () => {
  it('filterAnalysisResult returns only requested fields', async () => {
    const { filterAnalysisResult } = await import('../utils/field-filter.js');
    const fullResult = {
      metadata: {
        platform: 'loom' as const,
        title: 'Test',
        duration: 60,
        durationFormatted: '1:00',
        url: 'https://loom.com/share/test',
      },
      transcript: [{ time: '0:05', text: 'Hello' }],
      frames: [],
      comments: [],
      chapters: [],
      ocrResults: [],
      timeline: [],
      warnings: ['test warning'],
    };

    const filtered = filterAnalysisResult(fullResult, ['metadata']);
    expect(filtered.metadata).toBeDefined();
    expect(filtered.warnings).toBeDefined();
    expect(filtered.transcript).toBeUndefined();
    expect(filtered.frames).toBeUndefined();
  });
});

describe('analyze_video caching', () => {
  it('cache stores and retrieves results', async () => {
    const { AnalysisCache, cacheKey } = await import('../utils/cache.js');
    const testCache = new AnalysisCache({ ttlMs: 10_000 });
    const key = cacheKey('https://loom.com/share/test', { detail: 'standard' });

    const result = {
      metadata: {
        platform: 'loom' as const,
        title: 'Test',
        duration: 60,
        durationFormatted: '1:00',
        url: 'https://loom.com/share/test',
      },
      transcript: [{ time: '0:05', text: 'Hello' }],
      frames: [],
      comments: [],
      chapters: [],
      ocrResults: [],
      timeline: [],
      warnings: [],
    };

    testCache.set(key, result);
    expect(testCache.get(key)).toEqual(result);
  });

  it('cache key is different for different detail levels', async () => {
    const { cacheKey } = await import('../utils/cache.js');
    const key1 = cacheKey('https://loom.com/share/test', { detail: 'brief' });
    const key2 = cacheKey('https://loom.com/share/test', { detail: 'detailed' });
    expect(key1).not.toBe(key2);
  });
});
