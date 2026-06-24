import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAdapters, registerAdapter } from '../adapters/adapter.interface.js';
import type { IVideoAdapter } from '../adapters/adapter.interface.js';
import type { IAdapterCapabilities, IVideoMetadata } from '../types.js';
import { getAnalysis, resolveAnalyzeParams } from './analyze-core.js';

function mockAdapter(overrides: Partial<IVideoAdapter> = {}): IVideoAdapter {
  const capabilities: IAdapterCapabilities = {
    transcript: true,
    metadata: true,
    comments: false,
    chapters: false,
    aiSummary: false,
    videoDownload: false,
    ...overrides.capabilities,
  };
  const metadata: IVideoMetadata = {
    platform: 'loom',
    title: 'Mock',
    duration: 120,
    durationFormatted: '2:00',
    url: 'mock',
  };
  return {
    name: 'loom',
    capabilities,
    canHandle: () => true,
    getMetadata: vi.fn().mockResolvedValue(metadata),
    getTranscript: vi.fn().mockResolvedValue([{ time: '0:01', text: 'hello' }]),
    getComments: vi.fn().mockResolvedValue([]),
    getChapters: vi.fn().mockResolvedValue([]),
    getAiSummary: vi.fn().mockResolvedValue(null),
    downloadVideo: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('getAnalysis (brief, no frames)', () => {
  beforeEach(() => clearAdapters());
  afterEach(() => clearAdapters());

  it('returns metadata + transcript without touching frame extraction', async () => {
    registerAdapter(mockAdapter());
    const params = resolveAnalyzeParams({ detail: 'brief' });
    const { result, cleanup } = await getAnalysis('https://www.loom.com/share/aaa', params);

    expect(result.metadata.title).toBe('Mock');
    expect(result.transcript).toHaveLength(1);
    expect(result.frames).toHaveLength(0);
    await cleanup();
  });

  it('labels a muted clip distinctly from a missing transcript', async () => {
    registerAdapter(
      mockAdapter({
        getTranscript: vi.fn().mockResolvedValue([]),
        getMetadata: vi.fn().mockResolvedValue({
          platform: 'loom',
          title: 'Silent',
          duration: 30,
          durationFormatted: '0:30',
          url: 'mock',
          hasAudio: false,
        }),
      }),
    );
    const params = resolveAnalyzeParams({ detail: 'brief' });
    const { result } = await getAnalysis('https://www.loom.com/share/bbb', params);

    expect(result.warnings.some((w) => w.includes('No audio track'))).toBe(true);
    expect(result.warnings.some((w) => w === 'No transcript available for this video.')).toBe(
      false,
    );
  });
});

describe('getAnalysis caching', () => {
  beforeEach(() => clearAdapters());
  afterEach(() => clearAdapters());

  it('serves a repeat call from cache (adapter invoked once)', async () => {
    const adapter = mockAdapter();
    registerAdapter(adapter);
    const params = resolveAnalyzeParams({ detail: 'brief' });

    await (await getAnalysis('https://www.loom.com/share/cache-1', params)).cleanup();
    await (await getAnalysis('https://www.loom.com/share/cache-1', params)).cleanup();

    expect(adapter.getMetadata).toHaveBeenCalledTimes(1);
  });

  it('forceRefresh bypasses the cache and re-invokes the adapter', async () => {
    const adapter = mockAdapter();
    registerAdapter(adapter);

    await (
      await getAnalysis(
        'https://www.loom.com/share/cache-2',
        resolveAnalyzeParams({ detail: 'brief' }),
      )
    ).cleanup();
    await (
      await getAnalysis(
        'https://www.loom.com/share/cache-2',
        resolveAnalyzeParams({ detail: 'brief', forceRefresh: true }),
      )
    ).cleanup();

    expect(adapter.getMetadata).toHaveBeenCalledTimes(2);
  });
});

describe('getAnalysis OCR-before-dedup pipeline (real ffmpeg)', () => {
  const execFile = promisify(execFileCb);
  const require = createRequire(import.meta.url);
  const ffmpegPath = require('ffmpeg-static') as string;
  let whiteClip: string;

  beforeAll(async () => {
    // A short STATIC, non-black clip: scene detection finds no cuts → the
    // uniform-sampling fallback runs, frames survive the black-frame filter, and
    // the OCR-before-dedup branch executes end to end. (tiny.mp4 is pure black,
    // so its frames are stripped before that branch — unusable here.)
    const dir = await mkdtemp(join(tmpdir(), 'analyze-core-it-'));
    whiteClip = join(dir, 'white.mp4');
    await execFile(ffmpegPath, [
      '-f',
      'lavfi',
      '-i',
      'color=c=white:s=160x120:d=2:r=5',
      '-pix_fmt',
      'yuv420p',
      whiteClip,
      '-y',
    ]);
  });

  beforeEach(() => clearAdapters());
  afterEach(() => clearAdapters());

  it('extracts frames and keeps frames/ocrResults consistent on a local clip', async () => {
    registerAdapter(
      mockAdapter({
        capabilities: {
          transcript: true,
          metadata: true,
          comments: false,
          chapters: false,
          aiSummary: false,
          videoDownload: true,
        },
        getTranscript: vi.fn().mockResolvedValue([]),
        getMetadata: vi.fn().mockResolvedValue({
          platform: 'loom',
          title: 'White',
          duration: 2,
          durationFormatted: '0:02',
          url: 'mock',
          hasAudio: false, // skip the Whisper fallback (keeps the test fast)
        }),
        downloadVideo: vi.fn().mockResolvedValue(whiteClip),
      }),
    );

    const params = resolveAnalyzeParams({ detail: 'standard', maxFrames: 6 });
    const { result, cleanup } = await getAnalysis('https://www.loom.com/share/white', params);
    try {
      expect(result.frames.length).toBeGreaterThan(0);
      expect(Array.isArray(result.ocrResults)).toBe(true);
      // OCR results are a (possibly sparse) subset — never more than the frames.
      expect(result.ocrResults.length).toBeLessThanOrEqual(result.frames.length);
    } finally {
      await cleanup();
    }
  });
});

describe('resolveAnalyzeParams', () => {
  it('threads per-call transcription overrides', () => {
    const params = resolveAnalyzeParams({
      model: 'medium',
      language: 'pt',
      initialPrompt: 'Doha, Smiles',
    });
    expect(params.transcribe).toEqual({
      model: 'medium',
      language: 'pt',
      initialPrompt: 'Doha, Smiles',
    });
  });

  it('applies detail-level defaults (standard → 20 scene frames)', () => {
    const params = resolveAnalyzeParams({});
    expect(params.detail).toBe('standard');
    expect(params.maxFrames).toBe(20);
    expect(params.skipFrames).toBe(false);
    expect(params.ocrLanguage).toBe('eng+por');
  });
});
