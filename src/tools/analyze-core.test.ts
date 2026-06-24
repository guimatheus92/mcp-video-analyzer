import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    const result = await getAnalysis('https://www.loom.com/share/aaa', params);

    expect(result.metadata.title).toBe('Mock');
    expect(result.transcript).toHaveLength(1);
    expect(result.frames).toHaveLength(0);
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
    const result = await getAnalysis('https://www.loom.com/share/bbb', params);

    expect(result.warnings.some((w) => w.includes('No audio track'))).toBe(true);
    expect(result.warnings.some((w) => w === 'No transcript available for this video.')).toBe(
      false,
    );
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
