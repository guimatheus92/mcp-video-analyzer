import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAdapters, registerAdapter } from '../adapters/adapter.interface.js';
import type { IVideoAdapter } from '../adapters/adapter.interface.js';
import type { IAdapterCapabilities, IAnalysisResult, IVideoMetadata } from '../types.js';
import type { ResultDefiningParams } from '../utils/analysis-sidecar.js';
import { getAnalysis, resolveAnalyzeParams } from './analyze-core.js';
import type { AnalysisHandle, AnalyzeOptions } from './analyze-core.js';

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

describe('cache key covers every result-defining param', () => {
  beforeEach(() => {
    clearAdapters();
    vi.stubEnv('MCP_FRAME_MAX_WIDTH', '');
  });
  afterEach(() => {
    clearAdapters();
    vi.unstubAllEnvs();
  });

  // One row per ResultDefiningParams field; the `satisfies` forces this table
  // to grow whenever the interface grows. Each row proves its field actually
  // misses the cache — the exact defect review caught in #28, where maxWidth
  // changed the emitted frames but hashed to the same key. The compile-time
  // sibling of this table is the ExcludedFromCacheKey guard in analyze-core.ts.
  //
  // Base options keep skipFrames: true so rows stay on the frameless path.
  // The skipFrames: false row does enter the frame path: ffmpeg (strategy 1)
  // is off because mockAdapter's videoDownload capability is false, and the
  // puppeteer browser fallback (strategy 2, gated on duration > 0) is off
  // because the mock metadata reports duration 0 — without that, this row
  // would launch a real browser against the fake URL.
  const variants = {
    detail: { detail: 'detailed' },
    maxFrames: { maxFrames: 7 },
    threshold: { threshold: 0.5 },
    maxWidth: { maxWidth: 1920 },
    ocrLanguage: { ocrLanguage: 'deu' },
    model: { model: 'medium' },
    language: { language: 'pt' },
    initialPrompt: { initialPrompt: 'Smiles glossary' },
    skipFrames: { skipFrames: false },
  } satisfies Record<keyof ResultDefiningParams, NonNullable<AnalyzeOptions>>;

  it.each(Object.entries(variants))(
    'a repeat call differing only in %s misses the cache',
    async (field, delta) => {
      const adapter = mockAdapter({
        getMetadata: vi.fn().mockResolvedValue({
          platform: 'loom',
          title: 'Mock',
          duration: 0,
          durationFormatted: '0:00',
          url: 'mock',
        }),
      });
      registerAdapter(adapter);
      const url = `https://www.loom.com/share/key-${field}`;

      await (await getAnalysis(url, resolveAnalyzeParams({ skipFrames: true }))).cleanup();
      await (
        await getAnalysis(url, resolveAnalyzeParams({ skipFrames: true, ...delta }))
      ).cleanup();

      // A miss re-runs the pipeline; a hit would leave this at 1 (the bug).
      expect(adapter.getMetadata).toHaveBeenCalledTimes(2);
    },
  );

  it('maxWidth equal to the 800px default still HITS (keyedFrameMaxWidth normalization)', async () => {
    const adapter = mockAdapter();
    registerAdapter(adapter);
    const url = 'https://www.loom.com/share/key-default-width';

    await (await getAnalysis(url, resolveAnalyzeParams({ skipFrames: true }))).cleanup();
    await (
      await getAnalysis(url, resolveAnalyzeParams({ skipFrames: true, maxWidth: 800 }))
    ).cleanup();

    expect(adapter.getMetadata).toHaveBeenCalledTimes(1);
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
  }, 20_000);

  it('re-runs on a changed maxWidth instead of serving the cached frames', async () => {
    // maxWidth changes the emitted images, so it must key the cache and the
    // sidecar like maxFrames does. It didn't: the second call — the "analyze for
    // an overview, then re-analyze the same URL at native resolution for a close
    // read" workflow this parameter exists for — hit the 10-minute cache and got
    // the FIRST call's downscaled frames back, silently.
    vi.stubEnv('MCP_FRAME_MAX_WIDTH', '');
    const adapter = mockAdapter({
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
        hasAudio: false,
      }),
      downloadVideo: vi.fn().mockResolvedValue(whiteClip),
    });
    registerAdapter(adapter);

    const url = 'https://www.loom.com/share/width-key';
    const analyzeAt = (maxWidth: number): Promise<AnalysisHandle> =>
      getAnalysis(url, resolveAnalyzeParams({ detail: 'standard', maxFrames: 2, maxWidth }));
    const widthsOf = (result: IAnalysisResult): Promise<number[]> =>
      Promise.all(result.frames.map(async (f) => (await sharp(f.filePath).metadata()).width ?? 0));

    const first = await analyzeAt(100);
    const capped = await widthsOf(first.result);
    await first.cleanup();

    const second = await analyzeAt(0);
    // Assert the re-run BEFORE reading the images: when the key is shared this
    // is a cache hit whose frames point into the temp dir the first call already
    // cleaned up, and a missing-file error would obscure the actual defect.
    expect(adapter.downloadVideo).toHaveBeenCalledTimes(2);
    const native = await widthsOf(second.result);
    await second.cleanup();

    expect(capped.length).toBeGreaterThan(0);
    expect(capped.every((w) => w === 100)).toBe(true);
    // The clip is 160px wide: 160 here proves the second call re-ran the
    // pipeline rather than replaying the 100px result.
    expect(native.every((w) => w === 160)).toBe(true);

    // ...and the key still caches: repeating a width already analyzed must NOT
    // re-run, or "cache miss" would just be "cache broken". (Measured by the
    // adapter call count, not by the frames — a cache hit hands back paths into
    // the temp dir the first call already cleaned up.)
    const repeat = await getAnalysis(
      url,
      resolveAnalyzeParams({ detail: 'standard', maxFrames: 2, maxWidth: 0 }),
    );
    await repeat.cleanup();
    expect(adapter.downloadVideo).toHaveBeenCalledTimes(2);
    vi.unstubAllEnvs();
    // Three full real-ffmpeg pipeline runs; the 5s default is one scheduler
    // hiccup away from a flake on a loaded machine.
  }, 20_000);

  it('runs OCR on the original frames, not the optimized copies', async () => {
    // Regression: optimization used to overwrite the frame paths before OCR, so
    // recognition read the 800px downscale. On a dense UI capture that yields no
    // text, the text-aware dedup then has nothing to compare, falls back to the
    // coarse visual hash, and a static-layout clip collapses to a single frame.
    const ocr = await import('../processors/frame-ocr.js');
    const spy = vi.spyOn(ocr, 'ocrFrames');

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
          hasAudio: false,
        }),
        downloadVideo: vi.fn().mockResolvedValue(whiteClip),
      }),
    );

    const params = resolveAnalyzeParams({ detail: 'standard', maxFrames: 4 });
    const { result, cleanup } = await getAnalysis('https://www.loom.com/share/white2', params);
    try {
      expect(spy).toHaveBeenCalled();
      const ocrPaths = (spy.mock.calls[0]?.[0] ?? []).map((f) => basename(f.filePath));
      expect(ocrPaths.length).toBeGreaterThan(0);
      expect(ocrPaths.every((name) => !name.startsWith('opt_'))).toBe(true);
      // The emitted frames are still the optimized ones — only OCR reads originals.
      expect(result.frames.every((f) => basename(f.filePath).startsWith('opt_'))).toBe(true);
    } finally {
      spy.mockRestore();
      await cleanup();
    }
  }, 20_000);
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

  it('leaves maxFrames undefined by default (duration-adaptive, resolved later)', () => {
    const params = resolveAnalyzeParams({});
    expect(params.detail).toBe('standard');
    expect(params.maxFrames).toBeUndefined();
    expect(params.skipFrames).toBe(false);
    expect(params.ocrLanguage).toBe('eng+por');
  });
});
