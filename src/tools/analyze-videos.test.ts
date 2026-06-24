import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAdapters, registerAdapter } from '../adapters/adapter.interface.js';
import type { IVideoAdapter } from '../adapters/adapter.interface.js';
import type { IAdapterCapabilities } from '../types.js';
import { resolveAnalyzeParams } from './analyze-core.js';
import { runBatch } from './analyze-videos.js';

/** Adapter that only handles URLs containing "good"; anything else is unsupported. */
function selectiveAdapter(): IVideoAdapter {
  const capabilities: IAdapterCapabilities = {
    transcript: true,
    metadata: true,
    comments: false,
    chapters: false,
    aiSummary: false,
    videoDownload: false,
  };
  return {
    name: 'loom',
    capabilities,
    canHandle: (url: string) => url.includes('good'),
    getMetadata: vi.fn().mockResolvedValue({
      platform: 'loom',
      title: 'Mock',
      duration: 10,
      durationFormatted: '0:10',
      url: 'mock',
    }),
    getTranscript: vi.fn().mockResolvedValue([{ time: '0:01', text: 'hello' }]),
    getComments: vi.fn().mockResolvedValue([]),
    getChapters: vi.fn().mockResolvedValue([]),
    getAiSummary: vi.fn().mockResolvedValue(null),
    downloadVideo: vi.fn().mockResolvedValue(null),
  };
}

describe('runBatch', () => {
  beforeEach(() => clearAdapters());
  afterEach(() => clearAdapters());

  it('captures per-item failures without aborting the batch and aggregates a summary', async () => {
    registerAdapter(selectiveAdapter());
    const params = resolveAnalyzeParams({ detail: 'brief' });

    const sources = [
      'https://www.loom.com/share/good-1',
      'https://www.loom.com/share/bad-x',
      'https://www.loom.com/share/good-2',
    ];
    const { summary, results } = await runBatch(sources, params, undefined, 2);

    expect(summary).toEqual({ total: 3, ok: 2, failed: 1, concurrency: 2 });

    // Order is preserved.
    expect(results.map((r) => r.source)).toEqual(sources);

    // The unsupported source fails structurally; the others succeed.
    const bad = results[1];
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/unsupported/i);

    const good = results[0];
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.title).toBe('Mock');
      expect(good.transcriptEntries).toBe(1);
      expect(good.frameCount).toBe(0); // brief → no frames
    }
  });

  it('includes field-filtered data only when fields are requested', async () => {
    registerAdapter(selectiveAdapter());
    const params = resolveAnalyzeParams({ detail: 'brief' });

    const withoutFields = await runBatch(
      ['https://www.loom.com/share/good-nofields'],
      params,
      undefined,
      1,
    );
    const w0 = withoutFields.results[0];
    expect(w0.ok && w0.data).toBeUndefined();

    const withFields = await runBatch(
      ['https://www.loom.com/share/good-fields'],
      params,
      ['metadata'],
      1,
    );
    const f0 = withFields.results[0];
    expect(f0.ok).toBe(true);
    if (f0.ok) expect(f0.data?.metadata?.title).toBe('Mock');
  });
});
