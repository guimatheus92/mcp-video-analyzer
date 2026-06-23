import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '../utils/temp-files.js';
import { TwelveLabsAdapter } from './twelvelabs.adapter.js';

const DIRECT_URL = 'https://example.com/demo.mp4';

const ANALYSIS_TEXT = `SUMMARY:
A short screencast demonstrating a checkout bug where the cart total fails to update.

TRANSCRIPT:
[0:05] Let me add this item to the cart.
[0:12] Notice the total did not update.
[1:03] That's the bug.`;

interface MockResponse {
  ok?: boolean;
  status?: number;
  json?: unknown;
  text?: string;
}

/**
 * Configurable mock of the TwelveLabs REST flow. By default the asset goes
 * `pending -> ready` (one poll) and the analyze task goes `pending -> ready`
 * (one poll), so the polling loops actually run. Each `*Poll` array is consumed
 * sequentially, holding on the last element.
 */
function mockTwelveLabsFetch(
  opts: {
    assetPost?: MockResponse;
    assetPolls?: MockResponse[];
    taskPost?: MockResponse;
    taskPolls?: MockResponse[];
  } = {},
): ReturnType<typeof vi.fn> {
  const assetPost = opts.assetPost ?? { json: { _id: 'asset_1', status: 'pending' } };
  const assetPolls = opts.assetPolls ?? [{ json: { status: 'ready' } }];
  const taskPost = opts.taskPost ?? { json: { task_id: 'task_1', status: 'pending' } };
  const taskPolls = opts.taskPolls ?? [
    { json: { status: 'ready', result: { data: ANALYSIS_TEXT } } },
  ];
  let assetIdx = 0;
  let taskIdx = 0;

  const respond = (r: MockResponse): Promise<unknown> =>
    Promise.resolve({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: () => Promise.resolve(r.json ?? {}),
      text: () => Promise.resolve(r.text ?? ''),
    });
  const next = (arr: MockResponse[], i: number): MockResponse => arr[Math.min(i, arr.length - 1)];

  return vi.fn().mockImplementation((input: string, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/assets') && method === 'POST') return respond(assetPost);
    if (url.includes('/assets/')) return respond(next(assetPolls, assetIdx++));
    if (url.endsWith('/analyze/tasks') && method === 'POST') return respond(taskPost);
    if (url.includes('/analyze/tasks/')) return respond(next(taskPolls, taskIdx++));
    return respond({ ok: false, status: 404, text: 'unexpected' });
  });
}

describe('TwelveLabsAdapter', () => {
  // Tiny timing so the poll/timeout branches run without real 3s sleeps.
  let adapter: TwelveLabsAdapter;
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TWELVELABS_API_KEY;

  beforeEach(() => {
    adapter = new TwelveLabsAdapter({ pollIntervalMs: 0, requestTimeoutMs: 1000 });
    process.env.TWELVELABS_API_KEY = 'tlk_test_key';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TWELVELABS_API_KEY;
    else process.env.TWELVELABS_API_KEY = originalKey;
    vi.restoreAllMocks();
  });

  describe('canHandle', () => {
    it('handles direct video URLs (.mp4/.webm/.mov) when the API key is set', () => {
      expect(adapter.canHandle(DIRECT_URL)).toBe(true);
      expect(adapter.canHandle('https://example.com/clip.webm')).toBe(true);
      expect(adapter.canHandle('https://example.com/clip.mov')).toBe(true);
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

  describe('getTranscript', () => {
    it('parses Pegasus output into timestamped entries (exercises both poll loops)', async () => {
      globalThis.fetch = mockTwelveLabsFetch();
      const entries = await adapter.getTranscript(DIRECT_URL);
      expect(entries).toHaveLength(3);
      expect(entries[0].time).toBe('0:05');
      expect(entries[0].text).toContain('add this item to the cart');
      expect(entries[2].time).toBe('1:03');
    });

    it('throws (not []) when the API fails, so the tool layer can surface the reason', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('bad key') });
      await expect(adapter.getTranscript(DIRECT_URL)).rejects.toThrow(/401/);
    });

    it('parses HH:MM:SS timestamps', async () => {
      globalThis.fetch = mockTwelveLabsFetch({
        taskPolls: [
          { json: { status: 'ready', result: { data: 'TRANSCRIPT:\n[1:02:03] An hour in.' } } },
        ],
      });
      const entries = await adapter.getTranscript(DIRECT_URL);
      expect(entries).toEqual([{ time: '1:02:03', text: 'An hour in.' }]);
    });

    it('treats the "(no spoken dialogue)" sentinel as an empty transcript', async () => {
      globalThis.fetch = mockTwelveLabsFetch({
        taskPolls: [
          {
            json: {
              status: 'ready',
              result: { data: 'SUMMARY:\nSilent clip.\nTRANSCRIPT:\n[00:00] (no spoken dialogue)' },
            },
          },
        ],
      });
      expect(await adapter.getTranscript(DIRECT_URL)).toEqual([]);
    });

    it('returns an empty transcript when there is no TRANSCRIPT marker', async () => {
      globalThis.fetch = mockTwelveLabsFetch({
        taskPolls: [
          {
            json: {
              status: 'ready',
              result: { data: 'SUMMARY:\nJust a summary, no transcript section.' },
            },
          },
        ],
      });
      expect(await adapter.getTranscript(DIRECT_URL)).toEqual([]);
    });
  });

  describe('getAiSummary', () => {
    it('returns the Pegasus summary section', async () => {
      globalThis.fetch = mockTwelveLabsFetch();
      const summary = await adapter.getAiSummary(DIRECT_URL);
      expect(summary).toContain('checkout bug');
      expect(summary).not.toContain('TRANSCRIPT');
    });

    it('throws when the API fails', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('err') });
      await expect(adapter.getAiSummary(DIRECT_URL)).rejects.toThrow(/500/);
    });

    it('reads alternate result keys (e.g. { text })', async () => {
      globalThis.fetch = mockTwelveLabsFetch({
        taskPolls: [
          { json: { status: 'ready', result: { text: 'SUMMARY:\nFrom the text key.' } } },
        ],
      });
      expect(await adapter.getAiSummary(DIRECT_URL)).toContain('From the text key');
    });

    it('throws on an unrecognized result shape instead of stringifying it', async () => {
      globalThis.fetch = mockTwelveLabsFetch({
        taskPolls: [{ json: { status: 'ready', result: { unexpected_field: 'oops' } } }],
      });
      await expect(adapter.getAiSummary(DIRECT_URL)).rejects.toThrow(/no recognized text field/);
    });
  });

  describe('getMetadata', () => {
    it('derives a duration floor from the last transcript timestamp', async () => {
      globalThis.fetch = mockTwelveLabsFetch();
      const metadata = await adapter.getMetadata(DIRECT_URL);
      expect(metadata.platform).toBe('twelvelabs');
      expect(metadata.title).toBe('demo.mp4');
      expect(metadata.url).toBe(DIRECT_URL);
      expect(metadata.duration).toBe(63); // last entry [1:03]
      expect(metadata.durationFormatted).toBe('1:03');
    });

    it('reports duration 0 when there is no transcript', async () => {
      globalThis.fetch = mockTwelveLabsFetch({
        taskPolls: [{ json: { status: 'ready', result: { data: 'SUMMARY:\nNo speech here.' } } }],
      });
      const metadata = await adapter.getMetadata(DIRECT_URL);
      expect(metadata.duration).toBe(0);
      expect(metadata.durationFormatted).toBe('0:00');
    });

    it('throws when analysis fails', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('bad key') });
      await expect(adapter.getMetadata(DIRECT_URL)).rejects.toThrow(/401/);
    });
  });

  describe('asset polling', () => {
    it('throws when the asset reports failed', async () => {
      globalThis.fetch = mockTwelveLabsFetch({ assetPolls: [{ json: { status: 'failed' } }] });
      await expect(adapter.getTranscript(DIRECT_URL)).rejects.toThrow(/asset .* processing failed/);
    });

    it('throws when the asset never becomes ready before the deadline', async () => {
      adapter = new TwelveLabsAdapter({
        pollIntervalMs: 1,
        assetReadyTimeoutMs: 5,
        requestTimeoutMs: 1000,
      });
      globalThis.fetch = mockTwelveLabsFetch({ assetPolls: [{ json: { status: 'pending' } }] });
      await expect(adapter.getTranscript(DIRECT_URL)).rejects.toThrow(/not ready in time/);
    });
  });

  describe('analyze polling', () => {
    it('re-polls a pending task until it is ready', async () => {
      globalThis.fetch = mockTwelveLabsFetch({
        taskPolls: [
          { json: { status: 'pending' } },
          { json: { status: 'ready', result: { data: ANALYSIS_TEXT } } },
        ],
      });
      const entries = await adapter.getTranscript(DIRECT_URL);
      expect(entries).toHaveLength(3);
    });

    it('throws when the analyze task reports failed', async () => {
      globalThis.fetch = mockTwelveLabsFetch({ taskPolls: [{ json: { status: 'failed' } }] });
      await expect(adapter.getTranscript(DIRECT_URL)).rejects.toThrow(/analyze task .* failed/);
    });

    it('throws when the analyze task never finishes before the deadline', async () => {
      adapter = new TwelveLabsAdapter({
        pollIntervalMs: 1,
        analyzeTimeoutMs: 5,
        requestTimeoutMs: 1000,
      });
      globalThis.fetch = mockTwelveLabsFetch({ taskPolls: [{ json: { status: 'pending' } }] });
      await expect(adapter.getTranscript(DIRECT_URL)).rejects.toThrow(/timed out/);
    });
  });

  describe('analysis caching', () => {
    it('runs a single analysis when transcript and summary are requested together', async () => {
      const fetchMock = mockTwelveLabsFetch();
      globalThis.fetch = fetchMock;
      const [entries, summary] = await Promise.all([
        adapter.getTranscript(DIRECT_URL),
        adapter.getAiSummary(DIRECT_URL),
      ]);
      expect(entries.length).toBe(3);
      expect(summary).toContain('checkout bug');
      const assetPosts = fetchMock.mock.calls.filter((c) =>
        String(c[0]).endsWith('/assets'),
      ).length;
      expect(assetPosts).toBe(1);
    });

    it('re-analyzes once the in-flight entry has settled (eviction contract)', async () => {
      const fetchMock = mockTwelveLabsFetch();
      globalThis.fetch = fetchMock;
      await adapter.getTranscript(DIRECT_URL);
      await adapter.getTranscript(DIRECT_URL); // after the first settled -> new analysis
      const assetPosts = fetchMock.mock.calls.filter((c) =>
        String(c[0]).endsWith('/assets'),
      ).length;
      expect(assetPosts).toBe(2);
    });
  });

  describe('getComments / getChapters', () => {
    it('returns empty arrays', async () => {
      expect(await adapter.getComments(DIRECT_URL)).toEqual([]);
      expect(await adapter.getChapters(DIRECT_URL)).toEqual([]);
    });
  });

  describe('downloadVideo', () => {
    it('streams the video to the destination directory', async () => {
      const readableStream = new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('fake video content'));
          controller.close();
        },
      });
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, body: readableStream });
      const tempDir = await createTempDir();
      try {
        const result = await adapter.downloadVideo(DIRECT_URL, tempDir);
        expect(result).not.toBeNull();
        expect(existsSync(result as string)).toBe(true);
        expect(readFileSync(result as string).toString()).toBe('fake video content');
      } finally {
        await cleanupTempDir(tempDir).catch(() => undefined);
      }
    });

    it('returns null when the download response is not ok', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
      const tempDir = await createTempDir();
      try {
        expect(await adapter.downloadVideo(DIRECT_URL, tempDir)).toBeNull();
      } finally {
        await cleanupTempDir(tempDir).catch(() => undefined);
      }
    });
  });
});
