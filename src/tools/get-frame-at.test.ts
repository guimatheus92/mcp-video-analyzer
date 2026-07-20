import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FastMCP } from 'fastmcp';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { captureToolExecute, generateTestClip, noProgress } from '../../test/helpers/index.js';
import { clearAdapters, registerAdapter } from '../adapters/adapter.interface.js';
import { LocalFileAdapter } from '../adapters/local-file.adapter.js';
import { registerGetFrameAt } from './get-frame-at.js';

function imageCount(result: { content: { type: string }[] }): number {
  return result.content.filter((c) => c.type === 'image').length;
}
function zeroFrameDoc(result: { content: { type: string; text?: string }[] }): {
  frameCount: number;
  warnings: string[];
} {
  const text = result.content.find((c) => c.type === 'text')?.text ?? '{}';
  return JSON.parse(text);
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
// line) when extraction failed. It must degrade like analyze_video.
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
  });
  afterEach(() => clearAdapters());

  it('returns frameCount 0 with warnings instead of throwing on a broken file', async () => {
    const execute = captureToolExecute(registerGetFrameAt);
    const result = await execute({ url: corruptClip, timestamp: '0:01' }, noProgress);

    const doc = zeroFrameDoc(result);
    expect(doc.frameCount).toBe(0);
    expect(imageCount(result)).toBe(0);
    expect(doc.warnings.join(' ')).toMatch(/could not extract a frame/i);
  });

  it('still returns the frame for a valid clip', async () => {
    const execute = captureToolExecute(registerGetFrameAt);
    const result = await execute({ url: realClip, timestamp: '0:01' }, noProgress);

    expect(imageCount(result)).toBe(1);
  });
});
