import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FastMCP, UserError } from 'fastmcp';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
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
import { extractBrowserFrames } from '../processors/browser-frame-extractor.js';
import { registerGetFrameAt } from './get-frame-at.js';

// The remote-path test drives Strategy 2 (browser fallback); stub it so it
// fails deterministically without a real browser.
vi.mock('../processors/browser-frame-extractor.js', () => ({
  extractBrowserFrames: vi.fn(),
}));

function remoteAdapter(): IVideoAdapter {
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
      platform: 'mock',
      title: 't',
      duration: 30,
      durationFormatted: '0:30',
      url: '',
    }),
    getTranscript: vi.fn().mockResolvedValue([]),
    getComments: vi.fn().mockResolvedValue([]),
    getChapters: vi.fn().mockResolvedValue([]),
    getAiSummary: vi.fn().mockResolvedValue(null),
    // download fails → falls through to the browser fallback with a warning.
    downloadVideo: vi.fn().mockImplementation((_u, _d, onWarning) => {
      onWarning?.('yt-dlp is not installed — install it to extract frames.');
      return Promise.resolve(null);
    }),
  };
}

describe('get_frame_at tool', () => {
  let server: FastMCP;

  beforeEach(() => {
    clearAdapters();
    server = new FastMCP({ name: 'test', version: '0.0.0' });
    registerGetFrameAt(server);
  });

  afterEach(() => {
    clearAdapters();
  });

  it('registers the tool on the server', () => {
    expect(server).toBeDefined();
  });
});

// Issue #26: get_frame_at used to throw a RAW ffmpeg Error (leaking the command
// line) when extraction failed. It must degrade like analyze_video — while
// still THROWING on invalid input.
describe('get_frame_at zero-frame handling (issue #26)', () => {
  let dir: string;
  let corruptClip: string;
  let realClip: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gfa-'));
    corruptClip = join(dir, 'corrupt.mp4');
    writeFileSync(corruptClip, Buffer.from('not a real video — ffmpeg will choke on this'));
    realClip = join(dir, 'testsrc.mp4');
    await generateTestClip(realClip);
  });

  beforeEach(() => {
    clearAdapters();
    registerAdapter(new LocalFileAdapter());
    vi.mocked(extractBrowserFrames).mockReset();
  });
  afterEach(() => clearAdapters());

  it('returns frameCount 0 with a leak-free warning instead of throwing on a broken file', async () => {
    const execute = captureToolExecute(registerGetFrameAt);
    const result = await execute({ url: corruptClip, timestamp: '0:01' }, noProgress);

    expect(frameCountOf(result)).toBe(0);
    expect(imageCount(result)).toBe(0);
    const warning = warningsOf(result).join(' ');
    expect(warning).toMatch(/could not be decoded/i);
    // The whole point of the fix: the ffmpeg command line must NOT leak.
    expect(warning).not.toMatch(/ffmpeg|Command failed|-i |node_modules/i);
  });

  it('still returns the frame for a valid clip', async () => {
    const execute = captureToolExecute(registerGetFrameAt);
    const result = await execute({ url: realClip, timestamp: '0:01' }, noProgress);

    expect(imageCount(result)).toBe(1);
    expect(frameCountOf(result)).toBe(1);
  });

  it('THROWS on an invalid timestamp (input validation, not degradation)', async () => {
    const execute = captureToolExecute(registerGetFrameAt);
    await expect(execute({ url: realClip, timestamp: 'not-a-time' }, noProgress)).rejects.toThrow(
      UserError,
    );
  });

  it('degrades on the remote browser-fallback path, keeping the download warning', async () => {
    clearAdapters();
    registerAdapter(remoteAdapter());
    vi.mocked(extractBrowserFrames).mockRejectedValue(new Error('no browser available'));

    const execute = captureToolExecute(registerGetFrameAt);
    const result = await execute(
      { url: 'https://example.com/x.mp4', timestamp: '0:01' },
      noProgress,
    );

    expect(frameCountOf(result)).toBe(0);
    // The download warning must survive alongside the browser-failure note.
    expect(warningsOf(result).join(' ')).toMatch(/yt-dlp is not installed/i);
    expect(warningsOf(result).join(' ')).toMatch(/browser extraction failed/i);
  });
});
