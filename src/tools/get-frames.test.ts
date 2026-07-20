import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FastMCP } from 'fastmcp';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FIXTURES_DIR,
  captureToolExecute,
  frameCountOf,
  generateTestClip,
  imageCount,
  noProgress,
  warningsOf,
} from '../../test/helpers/index.js';
import { clearAdapters, registerAdapter } from '../adapters/adapter.interface.js';
import type { IVideoAdapter } from '../adapters/adapter.interface.js';
import { LocalFileAdapter } from '../adapters/local-file.adapter.js';
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

// Issue #26: get_frames used to THROW when a clip filtered to zero frames,
// discarding the accumulated warnings. It must degrade like analyze_video.
describe('get_frames zero-frame handling (issue #26)', () => {
  const blackClip = join(FIXTURES_DIR, 'tiny.mp4'); // pure black → filtered to empty
  let realClip: string;

  beforeAll(async () => {
    realClip = join(mkdtempSync(join(tmpdir(), 'gf-')), 'testsrc.mp4');
    await generateTestClip(realClip);
  });

  beforeEach(() => {
    clearAdapters();
    registerAdapter(new LocalFileAdapter());
  });
  afterEach(() => clearAdapters());

  it('returns frameCount 0 with warnings instead of throwing', async () => {
    const execute = captureToolExecute(registerGetFrames);
    const result = await execute({ url: blackClip, options: { maxFrames: 5 } }, noProgress);

    expect(frameCountOf(result)).toBe(0);
    expect(imageCount(result)).toBe(0);
    // The reason must survive — the old throw discarded it. tiny.mp4 IS decodable
    // (frames extract then filter as black), so the reason must say "filtered",
    // not "no decodable stream".
    expect(warningsOf(result).join(' ')).toMatch(/filtered out as black/i);
  });

  it('still returns frames for content that survives filtering', async () => {
    const execute = captureToolExecute(registerGetFrames);
    const result = await execute({ url: realClip, options: { maxFrames: 5 } }, noProgress);

    expect(frameCountOf(result)).toBeGreaterThan(0);
    expect(imageCount(result)).toBeGreaterThan(0);
  });
});
