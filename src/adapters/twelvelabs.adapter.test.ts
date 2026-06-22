import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwelveLabsAdapter } from './twelvelabs.adapter.js';

const DIRECT_URL = 'https://example.com/demo.mp4';

const ANALYSIS_TEXT = `SUMMARY:
A short screencast demonstrating a checkout bug where the cart total fails to update.

TRANSCRIPT:
[0:05] Let me add this item to the cart.
[0:12] Notice the total did not update.
[1:03] That's the bug.`;

/**
 * Mock the TwelveLabs REST flow: POST /assets -> ready asset, POST
 * /analyze/tasks -> task id, GET /analyze/tasks/:id -> ready + result text.
 */
function mockTwelveLabsFetch(analysisText = ANALYSIS_TEXT): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation((input: string, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url.endsWith('/assets') && method === 'POST') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ _id: 'asset_1', status: 'ready' }),
      });
    }
    if (url.endsWith('/analyze/tasks') && method === 'POST') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ task_id: 'task_1', status: 'pending' }),
      });
    }
    if (url.includes('/analyze/tasks/task_1')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ status: 'ready', result: { data: analysisText } }),
      });
    }
    return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('unexpected') });
  });
}

describe('TwelveLabsAdapter', () => {
  let adapter: TwelveLabsAdapter;
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TWELVELABS_API_KEY;

  beforeEach(() => {
    adapter = new TwelveLabsAdapter();
    process.env.TWELVELABS_API_KEY = 'tlk_test_key';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TWELVELABS_API_KEY;
    else process.env.TWELVELABS_API_KEY = originalKey;
    vi.restoreAllMocks();
  });

  describe('canHandle', () => {
    it('handles direct video URLs when the API key is set', () => {
      expect(adapter.canHandle(DIRECT_URL)).toBe(true);
    });

    it('declines when the API key is not set (DirectAdapter takes over)', () => {
      delete process.env.TWELVELABS_API_KEY;
      expect(adapter.canHandle(DIRECT_URL)).toBe(false);
    });

    it('declines Loom URLs (handled by LoomAdapter)', () => {
      expect(adapter.canHandle('https://www.loom.com/share/abc123')).toBe(false);
    });

    it('declines non-video URLs', () => {
      expect(adapter.canHandle('https://example.com/page.html')).toBe(false);
    });
  });

  describe('getMetadata', () => {
    it('returns twelvelabs platform metadata derived from the URL', async () => {
      const metadata = await adapter.getMetadata(DIRECT_URL);
      expect(metadata.platform).toBe('twelvelabs');
      expect(metadata.title).toBe('demo.mp4');
      expect(metadata.url).toBe(DIRECT_URL);
    });
  });

  describe('getTranscript', () => {
    it('parses Pegasus output into timestamped transcript entries', async () => {
      globalThis.fetch = mockTwelveLabsFetch();
      const entries = await adapter.getTranscript(DIRECT_URL);
      expect(entries).toHaveLength(3);
      expect(entries[0].time).toBe('0:05');
      expect(entries[0].text).toContain('add this item to the cart');
      expect(entries[2].time).toBe('1:03');
    });

    it('returns [] when the API fails (graceful degradation)', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('err') });
      const entries = await adapter.getTranscript(DIRECT_URL);
      expect(entries).toEqual([]);
    });
  });

  describe('getAiSummary', () => {
    it('returns the Pegasus summary section', async () => {
      globalThis.fetch = mockTwelveLabsFetch();
      const summary = await adapter.getAiSummary(DIRECT_URL);
      expect(summary).toContain('checkout bug');
      expect(summary).not.toContain('TRANSCRIPT');
    });

    it('returns null when the API fails', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('bad key') });
      const summary = await adapter.getAiSummary(DIRECT_URL);
      expect(summary).toBeNull();
    });
  });

  describe('analysis caching', () => {
    it('runs a single analysis when transcript and summary are both requested', async () => {
      const fetchMock = mockTwelveLabsFetch();
      globalThis.fetch = fetchMock;
      const [entries, summary] = await Promise.all([
        adapter.getTranscript(DIRECT_URL),
        adapter.getAiSummary(DIRECT_URL),
      ]);
      expect(entries.length).toBe(3);
      expect(summary).toContain('checkout bug');
      // One asset POST + one analyze POST + one task GET = 3 calls total, not 6.
      const assetPosts = fetchMock.mock.calls.filter((c) =>
        String(c[0]).endsWith('/assets'),
      ).length;
      expect(assetPosts).toBe(1);
    });
  });

  describe('getComments / getChapters', () => {
    it('returns empty arrays', async () => {
      expect(await adapter.getComments(DIRECT_URL)).toEqual([]);
      expect(await adapter.getChapters(DIRECT_URL)).toEqual([]);
    });
  });
});
