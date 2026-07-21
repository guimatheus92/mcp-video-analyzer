import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FastMCP, UserError } from 'fastmcp';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  captureToolExecute,
  frameCountOf,
  generateTestClip,
  imageCount,
  noProgress,
  warningsOf,
} from '../../test/helpers/index.js';
import { clearAdapters, registerAdapter } from '../adapters/adapter.interface.js';
import { LocalFileAdapter } from '../adapters/local-file.adapter.js';
import { registerGetFrameBurst } from './get-frame-burst.js';

describe('get_frame_burst tool', () => {
  let server: FastMCP;

  beforeEach(() => {
    clearAdapters();
    server = new FastMCP({ name: 'test', version: '0.0.0' });
    registerGetFrameBurst(server);
  });

  afterEach(() => {
    clearAdapters();
  });

  it('registers the tool on the server', () => {
    expect(server).toBeDefined();
  });
});

// Issue #26: get_frame_burst used to throw a RAW ffmpeg Error (leaking the
// command line) when extraction failed. It must degrade like analyze_video —
// while still THROWING on invalid input.
describe('get_frame_burst zero-frame handling (issue #26)', () => {
  let dir: string;
  let corruptClip: string;
  let realClip: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gfb-'));
    corruptClip = join(dir, 'corrupt.mp4');
    writeFileSync(corruptClip, Buffer.from('not a real video — ffmpeg will choke on this'));
    realClip = join(dir, 'testsrc.mp4');
    await generateTestClip(realClip); // 3s clip
  });

  beforeEach(() => {
    clearAdapters();
    registerAdapter(new LocalFileAdapter());
  });
  afterEach(() => clearAdapters());

  it('returns frameCount 0 with a leak-free warning instead of throwing on a broken file', async () => {
    const execute = captureToolExecute(registerGetFrameBurst);
    const result = await execute(
      { url: corruptClip, from: '0:00', to: '0:02', count: 3 },
      noProgress,
    );

    expect(frameCountOf(result)).toBe(0);
    expect(imageCount(result)).toBe(0);
    const warning = warningsOf(result).join(' ');
    expect(warning).toMatch(/could not be decoded/i);
    expect(warning).not.toMatch(/ffmpeg|Command failed|-i |node_modules/i);
  });

  it('degrades when the range is past the clip end (ffmpeg succeeds, no frames)', async () => {
    const execute = captureToolExecute(registerGetFrameBurst);
    // Valid range, but well past the 3s clip → ffmpeg exits 0 with no files,
    // exercising the empty-array branch (distinct from the throw path above).
    const result = await execute({ url: realClip, from: '9:00', to: '9:02', count: 3 }, noProgress);

    expect(frameCountOf(result)).toBe(0);
    // Specifically the empty-array branch (ffmpeg exited 0, no files) — distinct
    // from the decode-failure catch above.
    expect(warningsOf(result).join(' ')).toMatch(/produced no frames/i);
  });

  it('still returns the requested number of frames for a valid clip', async () => {
    const execute = captureToolExecute(registerGetFrameBurst);
    const result = await execute({ url: realClip, from: '0:00', to: '0:02', count: 3 }, noProgress);

    // Exact count — a regression that ignores `count` or collapses to one frame
    // must fail here.
    expect(imageCount(result)).toBe(3);
    expect(frameCountOf(result)).toBe(3);
  });

  it('THROWS on a backwards range (input validation, not degradation)', async () => {
    const execute = captureToolExecute(registerGetFrameBurst);
    await expect(
      execute({ url: realClip, from: '0:05', to: '0:02', count: 3 }, noProgress),
    ).rejects.toThrow(UserError);
  });

  it('THROWS on a malformed timestamp', async () => {
    const execute = captureToolExecute(registerGetFrameBurst);
    await expect(
      execute({ url: realClip, from: 'nope', to: '0:02', count: 3 }, noProgress),
    ).rejects.toThrow(UserError);
  });
});
