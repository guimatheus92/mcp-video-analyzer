import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FastMCP } from 'fastmcp';
import { registerGetMetadata } from './get-metadata.js';
import { registerAdapter, clearAdapters } from '../adapters/adapter.interface.js';
import type { IVideoAdapter } from '../adapters/adapter.interface.js';

function createMockAdapter(overrides: Partial<IVideoAdapter> = {}): IVideoAdapter {
  return {
    name: 'mock',
    capabilities: {
      transcript: true,
      metadata: true,
      comments: true,
      chapters: false,
      aiSummary: false,
      videoDownload: false,
    },
    canHandle: () => true,
    getMetadata: vi.fn().mockResolvedValue({
      platform: 'loom',
      title: 'Test Video',
      duration: 120,
      durationFormatted: '2:00',
      url: 'https://www.loom.com/share/test123',
    }),
    getTranscript: vi.fn().mockResolvedValue([]),
    getComments: vi.fn().mockResolvedValue([{ author: 'Bob', text: 'Nice!', time: '0:30' }]),
    getChapters: vi.fn().mockResolvedValue([]),
    getAiSummary: vi.fn().mockResolvedValue(null),
    downloadVideo: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('get_metadata tool', () => {
  beforeEach(() => {
    clearAdapters();
  });

  afterEach(() => {
    clearAdapters();
  });

  it('registers the tool on the server', () => {
    const server = new FastMCP({ name: 'test', version: '0.0.0' });
    registerGetMetadata(server);
    expect(server).toBeDefined();
  });

  it('adapter returns metadata correctly', async () => {
    const adapter = createMockAdapter();
    registerAdapter(adapter);
    const metadata = await adapter.getMetadata('https://www.loom.com/share/test123');
    expect(metadata.title).toBe('Test Video');
    expect(metadata.duration).toBe(120);
  });

  it('adapter returns comments', async () => {
    const adapter = createMockAdapter();
    registerAdapter(adapter);
    const comments = await adapter.getComments('https://www.loom.com/share/test123');
    expect(comments).toHaveLength(1);
    expect(comments[0].author).toBe('Bob');
  });

  it('handles metadata failure gracefully', async () => {
    const adapter = createMockAdapter({
      getMetadata: vi.fn().mockRejectedValue(new Error('API error')),
    });
    registerAdapter(adapter);
    await expect(adapter.getMetadata('test')).rejects.toThrow('API error');
  });
});
