import { FastMCP } from 'fastmcp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAdapters, registerAdapter } from '../adapters/adapter.interface.js';
import type { IVideoAdapter } from '../adapters/adapter.interface.js';
import { registerGetTranscript } from './get-transcript.js';

function createMockAdapter(overrides: Partial<IVideoAdapter> = {}): IVideoAdapter {
  return {
    name: 'mock',
    capabilities: {
      transcript: true,
      metadata: true,
      comments: false,
      chapters: false,
      aiSummary: false,
      videoDownload: false,
    },
    canHandle: () => true,
    getMetadata: vi.fn().mockResolvedValue({
      platform: 'loom',
      title: 'Test',
      duration: 60,
      durationFormatted: '1:00',
      url: 'https://www.loom.com/share/test',
    }),
    getTranscript: vi.fn().mockResolvedValue([
      { time: '0:05', text: 'Hello world' },
      { time: '0:12', text: 'Testing transcript' },
    ]),
    getComments: vi.fn().mockResolvedValue([]),
    getChapters: vi.fn().mockResolvedValue([]),
    getAiSummary: vi.fn().mockResolvedValue(null),
    downloadVideo: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('get_transcript tool', () => {
  beforeEach(() => {
    clearAdapters();
  });

  afterEach(() => {
    clearAdapters();
  });

  it('registers the tool on the server', () => {
    const server = new FastMCP({ name: 'test', version: '0.0.0' });
    registerGetTranscript(server);
    expect(server).toBeDefined();
  });

  it('adapter returns transcript entries', () => {
    const adapter = createMockAdapter();
    registerAdapter(adapter);
    expect(adapter.getTranscript).toBeDefined();
  });

  it('adapter with no transcript capability returns empty', () => {
    const adapter = createMockAdapter({
      getTranscript: vi.fn().mockResolvedValue([]),
    });
    registerAdapter(adapter);
    expect(adapter.capabilities.videoDownload).toBe(false);
  });

  it('handles adapter with transcript data correctly', async () => {
    const adapter = createMockAdapter();
    registerAdapter(adapter);
    const transcript = await adapter.getTranscript('https://www.loom.com/share/test');
    expect(transcript).toHaveLength(2);
    expect(transcript[0].text).toBe('Hello world');
  });

  it('handles adapter failure gracefully', async () => {
    const adapter = createMockAdapter({
      getTranscript: vi.fn().mockRejectedValue(new Error('Network error')),
    });
    registerAdapter(adapter);
    await expect(adapter.getTranscript('https://www.loom.com/share/test')).rejects.toThrow();
  });
});
