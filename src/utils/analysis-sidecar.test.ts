import { existsSync } from 'node:fs';
import { appendFile, copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURES_DIR, createTestImage } from '../../test/helpers/index.js';
import type { IAnalysisResult } from '../types.js';
import {
  readAnalysisSidecar,
  sidecarsEnabled,
  transcriptToVtt,
  writeAnalysisSidecars,
} from './analysis-sidecar.js';
import { cleanupTempDir, createTempDir } from './temp-files.js';
import { parseVtt } from './vtt-parser.js';

function fakeResult(framePath: string): IAnalysisResult {
  return {
    metadata: {
      platform: 'local',
      title: 'clip.mp4',
      duration: 3,
      durationFormatted: '0:03',
      url: 'clip.mp4',
    },
    transcript: [{ time: '0:01', speaker: 'Ana', text: 'preço imperdível' }],
    frames: [{ time: '0:01', filePath: framePath, mimeType: 'image/jpeg' }],
    comments: [],
    chapters: [],
    ocrResults: [{ time: '0:01', text: 'R$ 99', confidence: 90 }],
    timeline: [],
    warnings: [],
  };
}

const PARAMS = { detail: 'standard', maxFrames: 20, threshold: 0.1 };

describe('transcriptToVtt', () => {
  it('round-trips text and speaker through parseVtt', () => {
    const vtt = transcriptToVtt([
      { time: '0:00', text: 'Olá' },
      { time: '0:05', speaker: 'Ana', text: 'tudo bem?' },
    ]);
    expect(vtt.startsWith('WEBVTT')).toBe(true);

    const parsed = parseVtt(vtt);
    expect(parsed).toEqual([
      { time: '0:00', endTime: '0:05', text: 'Olá' },
      { time: '0:05', endTime: '0:08', speaker: 'Ana', text: 'tudo bem?' },
    ]);
  });
});

describe('sidecar write/read', () => {
  beforeEach(() => {
    vi.stubEnv('MCP_WRITE_SIDECARS', '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does nothing when MCP_WRITE_SIDECARS is off', async () => {
    vi.stubEnv('MCP_WRITE_SIDECARS', '0');
    expect(sidecarsEnabled()).toBe(false);
    const tempDir = await createTempDir();
    try {
      const clip = join(tempDir, 'clip.mp4');
      await copyFile(join(FIXTURES_DIR, 'tiny.mp4'), clip);
      const frame = await createTestImage(tempDir, 'frame.jpg');
      const written = await writeAnalysisSidecars(clip, fakeResult(frame), PARAMS, {
        transcriptFromWhisper: true,
      });
      expect(written).toEqual([]);
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it('persists analysis + frames + vtt and reads them back when valid', async () => {
    const tempDir = await createTempDir();
    try {
      const clip = join(tempDir, 'clip.mp4');
      await copyFile(join(FIXTURES_DIR, 'tiny.mp4'), clip);
      const frame = await createTestImage(tempDir, 'frame.jpg');

      const written = await writeAnalysisSidecars(clip, fakeResult(frame), PARAMS, {
        transcriptFromWhisper: true,
      });
      expect(written.length).toBe(3);
      expect(existsSync(join(tempDir, 'clip.analysis.json'))).toBe(true);
      expect(existsSync(join(tempDir, 'clip.frames'))).toBe(true);
      expect(existsSync(join(tempDir, 'clip.vtt'))).toBe(true);

      const read = await readAnalysisSidecar(clip, PARAMS);
      expect(read).not.toBeNull();
      expect(read?.transcript).toHaveLength(1);
      expect(read?.ocrResults).toHaveLength(1);
      expect(read?.frames).toHaveLength(1);
      // Frame path was rewritten into the durable sibling dir and still exists.
      expect(read?.frames[0].filePath).toContain('clip.frames');
      expect(existsSync(read?.frames[0].filePath ?? '')).toBe(true);
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it('invalidates on differing params', async () => {
    const tempDir = await createTempDir();
    try {
      const clip = join(tempDir, 'clip.mp4');
      await copyFile(join(FIXTURES_DIR, 'tiny.mp4'), clip);
      const frame = await createTestImage(tempDir, 'frame.jpg');
      await writeAnalysisSidecars(clip, fakeResult(frame), PARAMS, { transcriptFromWhisper: true });

      const read = await readAnalysisSidecar(clip, { ...PARAMS, detail: 'detailed' });
      expect(read).toBeNull();
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it('invalidates when the source video changes (stamp mismatch)', async () => {
    const tempDir = await createTempDir();
    try {
      const clip = join(tempDir, 'clip.mp4');
      await copyFile(join(FIXTURES_DIR, 'tiny.mp4'), clip);
      const frame = await createTestImage(tempDir, 'frame.jpg');
      await writeAnalysisSidecars(clip, fakeResult(frame), PARAMS, { transcriptFromWhisper: true });

      await appendFile(clip, Buffer.from([0, 1, 2, 3])); // changes size → new stamp
      const read = await readAnalysisSidecar(clip, PARAMS);
      expect(read).toBeNull();
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it('never overwrites an existing .vtt and skips it for non-Whisper transcripts', async () => {
    const tempDir = await createTempDir();
    try {
      const clip = join(tempDir, 'clip.mp4');
      await copyFile(join(FIXTURES_DIR, 'tiny.mp4'), clip);
      const frame = await createTestImage(tempDir, 'frame.jpg');

      // transcriptFromWhisper=false → no .vtt is written at all.
      const written = await writeAnalysisSidecars(clip, fakeResult(frame), PARAMS, {
        transcriptFromWhisper: false,
      });
      expect(written).not.toContain(join(tempDir, 'clip.vtt'));
      expect(existsSync(join(tempDir, 'clip.vtt'))).toBe(false);

      // A pre-existing .vtt (e.g. the user's own GPU transcript) is preserved.
      const userVtt = join(tempDir, 'clip.vtt');
      await writeFile(userVtt, 'WEBVTT\n\nUSER CONTENT', 'utf8');
      await writeAnalysisSidecars(clip, fakeResult(frame), PARAMS, { transcriptFromWhisper: true });
      const { readFile } = await import('node:fs/promises');
      expect(await readFile(userVtt, 'utf8')).toContain('USER CONTENT');
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it('returns null for non-local sources', async () => {
    const read = await readAnalysisSidecar('https://www.loom.com/share/abc123', PARAMS);
    expect(read).toBeNull();
  });
});
