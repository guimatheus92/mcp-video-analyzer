import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURES_DIR } from '../../test/helpers/index.js';
import { clearAdapters, registerAdapter } from '../adapters/adapter.interface.js';
import type { IVideoAdapter } from '../adapters/adapter.interface.js';
import { getAnalysis, resolveAnalyzeParams } from './analyze-core.js';

// Pins the PIPELINE WIRING of the duration-adaptive budget: the extractors have
// their own `?? 20` fallbacks downstream, so reverting the resolveMaxFrames()
// call site to `params.maxFrames` (undefined by default) would compile cleanly
// and silently reinstate the fixed budget with every other test still green.
const state = vi.hoisted(() => ({ capturedMaxFrames: [] as (number | undefined)[] }));

vi.mock('../processors/frame-extractor.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    extractKeyFrames: async (
      _videoPath: string,
      _outputDir: string,
      opts: { maxFrames?: number },
    ) => {
      state.capturedMaxFrames.push(opts.maxFrames);
      return { frames: [], warnings: [] };
    },
  };
});

vi.mock('../processors/browser-frame-extractor.js', () => ({
  generateTimestamps: () => [],
  extractBrowserFrames: async () => [],
}));

function stubAdapter(duration: number): IVideoAdapter {
  return {
    name: 'direct',
    capabilities: {
      transcript: true,
      metadata: true,
      comments: false,
      chapters: false,
      aiSummary: false,
      videoDownload: true,
    },
    canHandle: (url: string) => url.startsWith('https://budget.test/'),
    getMetadata: async (url: string) => ({
      platform: 'direct' as const,
      title: 'stub',
      duration,
      durationFormatted: '0:00',
      url,
      hasAudio: false, // skip the Whisper fallback
    }),
    getTranscript: async () => [],
    getComments: async () => [],
    getChapters: async () => [],
    getAiSummary: async () => null,
    downloadVideo: async () => join(FIXTURES_DIR, 'tiny.mp4'),
  };
}

async function analyzedBudget(duration: number, maxFrames?: number): Promise<number | undefined> {
  clearAdapters();
  registerAdapter(stubAdapter(duration));
  const url = `https://budget.test/${duration}-${maxFrames ?? 'default'}`;
  const { cleanup } = await getAnalysis(url, resolveAnalyzeParams({ maxFrames }));
  await cleanup();
  return state.capturedMaxFrames.at(-1);
}

describe('duration-adaptive maxFrames wiring through getAnalysis', () => {
  beforeEach(() => {
    state.capturedMaxFrames.length = 0;
  });

  afterAll(() => {
    clearAdapters();
  });

  it('resolves the adaptive default from the video duration (700s → 60)', async () => {
    expect(await analyzedBudget(700)).toBe(60);
  });

  it('resolves the adaptive default for short clips (25s → 12)', async () => {
    expect(await analyzedBudget(25)).toBe(12);
  });

  it('an explicit maxFrames overrides the adaptive default', async () => {
    expect(await analyzedBudget(700, 7)).toBe(7);
  });
});
