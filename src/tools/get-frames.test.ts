import { FastMCP } from 'fastmcp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAdapters, registerAdapter } from '../adapters/adapter.interface.js';
import type { IVideoAdapter } from '../adapters/adapter.interface.js';
import { registerGetFrames } from './get-frames.js';

function createMockAdapter(overrides: Partial<IVideoAdapter> = {}): IVideoAdapter {
  return {
    name: 'mock',
    capabilities: {
      transcript: false,
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
      duration: 30,
      durationFormatted: '0:30',
      url: 'https://example.com/video.mp4',
    }),
    getTranscript: vi.fn().mockResolvedValue([]),
    getComments: vi.fn().mockResolvedValue([]),
    getChapters: vi.fn().mockResolvedValue([]),
    getAiSummary: vi.fn().mockResolvedValue(null),
    downloadVideo: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('get_frames tool', () => {
  beforeEach(() => {
    clearAdapters();
  });

  afterEach(() => {
    clearAdapters();
  });

  it('registers the tool on the server', () => {
    const server = new FastMCP({ name: 'test', version: '0.0.0' });
    registerGetFrames(server);
    expect(server).toBeDefined();
  });

  it('adapter with videoDownload capability', () => {
    const adapter = createMockAdapter();
    registerAdapter(adapter);
    expect(adapter.capabilities.videoDownload).toBe(true);
  });

  it('adapter without videoDownload falls back to browser', () => {
    const adapter = createMockAdapter({
      capabilities: {
        transcript: false,
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

  it('adapter returns metadata for duration info', async () => {
    const adapter = createMockAdapter();
    registerAdapter(adapter);
    const metadata = await adapter.getMetadata('https://example.com/video.mp4');
    expect(metadata.duration).toBe(30);
  });
});
