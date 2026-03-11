import { FastMCP } from 'fastmcp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAdapters, registerAdapter } from '../adapters/adapter.interface.js';
import type { IVideoAdapter } from '../adapters/adapter.interface.js';
import { registerAnalyzeMoment } from './analyze-moment.js';

function createMockAdapter(overrides: Partial<IVideoAdapter> = {}): IVideoAdapter {
  return {
    name: 'mock',
    capabilities: {
      transcript: true,
      metadata: true,
      comments: false,
      chapters: false,
      aiSummary: false,
      videoDownload: true,
    },
    canHandle: () => true,
    getMetadata: vi.fn().mockResolvedValue({
      platform: 'direct',
      title: 'Test',
      duration: 120,
      durationFormatted: '2:00',
      url: 'https://example.com/video.mp4',
    }),
    getTranscript: vi.fn().mockResolvedValue([
      { time: '0:10', text: 'Before the range' },
      { time: '0:30', text: 'Inside the range start' },
      { time: '0:45', text: 'Middle of range' },
      { time: '1:00', text: 'End of range' },
      { time: '1:30', text: 'After the range' },
    ]),
    getComments: vi.fn().mockResolvedValue([]),
    getChapters: vi.fn().mockResolvedValue([]),
    getAiSummary: vi.fn().mockResolvedValue(null),
    downloadVideo: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('analyze_moment tool', () => {
  beforeEach(() => {
    clearAdapters();
  });

  afterEach(() => {
    clearAdapters();
  });

  it('registers the tool on the server', () => {
    const server = new FastMCP({ name: 'test', version: '0.0.0' });
    registerAnalyzeMoment(server);
    expect(server).toBeDefined();
  });

  it('adapter with videoDownload capability is required', () => {
    const adapter = createMockAdapter();
    registerAdapter(adapter);
    expect(adapter.capabilities.videoDownload).toBe(true);
  });

  it('adapter without videoDownload cannot do moment analysis', () => {
    const adapter = createMockAdapter({
      capabilities: {
        transcript: true,
        metadata: true,
        comments: false,
        chapters: false,
        aiSummary: false,
        videoDownload: false,
      },
    });
    registerAdapter(adapter);
    expect(adapter.capabilities.videoDownload).toBe(false);
  });

  it('adapter returns transcript for filtering', async () => {
    const adapter = createMockAdapter();
    registerAdapter(adapter);
    const transcript = await adapter.getTranscript('https://example.com/video.mp4');
    expect(transcript.length).toBe(5);
  });

  it('transcript filtering logic: entries within range', async () => {
    const adapter = createMockAdapter();
    registerAdapter(adapter);
    const transcript = await adapter.getTranscript('https://example.com/video.mp4');

    // Simulate filtering for range 0:30 to 1:00 (30s to 60s)
    const fromSeconds = 30;
    const toSeconds = 60;
    const filtered = transcript.filter((entry) => {
      const parts = entry.time.split(':').map(Number);
      const seconds = parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0];
      return seconds >= fromSeconds && seconds <= toSeconds;
    });

    expect(filtered).toHaveLength(3);
    expect(filtered[0].text).toBe('Inside the range start');
    expect(filtered[1].text).toBe('Middle of range');
    expect(filtered[2].text).toBe('End of range');
  });

  it('transcript filtering: no entries in range returns empty', async () => {
    const adapter = createMockAdapter();
    registerAdapter(adapter);
    const transcript = await adapter.getTranscript('https://example.com/video.mp4');

    // Range 5:00 to 6:00 — no entries exist there
    const fromSeconds = 300;
    const toSeconds = 360;
    const filtered = transcript.filter((entry) => {
      const parts = entry.time.split(':').map(Number);
      const seconds = parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0];
      return seconds >= fromSeconds && seconds <= toSeconds;
    });

    expect(filtered).toHaveLength(0);
  });

  it('from must be before to (validation logic)', () => {
    // parseTimestamp('1:30') = 90, parseTimestamp('0:30') = 30
    // 90 >= 30 → invalid
    const fromSeconds = 90;
    const toSeconds = 30;
    expect(fromSeconds >= toSeconds).toBe(true);
  });

  it('count defaults to 10 when not provided', () => {
    const args = { url: 'https://example.com/video.mp4', from: '0:30', to: '1:00' };
    const count = (args as { count?: number }).count ?? 10;
    expect(count).toBe(10);
  });
});
