import { execFile as execFileCb } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURES_DIR } from '../../test/helpers/index.js';
import { cleanupTempDir, createTempDir } from '../utils/temp-files.js';
import { extractEmbeddedSubtitle } from './embedded-subtitles.js';

const execFile = promisify(execFileCb);
const require = createRequire(import.meta.url);
const ffmpegPath: string = require('ffmpeg-static') as string;

describe('extractEmbeddedSubtitle', () => {
  let tempDir: string;
  let videoWithSubs: string;

  beforeAll(async () => {
    tempDir = await createTempDir('embedded-subs-');

    // Build a fixture: tiny.mp4 + a tiny SRT muxed into an mkv container
    // (mp4 doesn't natively support srt streams; mkv does and is universally
    // available in ffmpeg-static).
    const srtPath = join(tempDir, 'subs.srt');
    writeFileSync(
      srtPath,
      [
        '1',
        '00:00:00,000 --> 00:00:01,500',
        'Hello from embedded subs.',
        '',
        '2',
        '00:00:01,500 --> 00:00:03,000',
        'Second cue.',
        '',
      ].join('\n'),
    );

    videoWithSubs = join(tempDir, 'with-subs.mkv');
    await execFile(ffmpegPath, [
      '-y',
      '-loglevel',
      'error',
      '-i',
      join(FIXTURES_DIR, 'tiny.mp4'),
      '-i',
      srtPath,
      '-c:v',
      'copy',
      '-c:s',
      'srt',
      videoWithSubs,
    ]);
  });

  afterAll(async () => {
    if (tempDir) await cleanupTempDir(tempDir);
  });

  it('extracts cues from a container with an embedded subtitle stream', async () => {
    const entries = await extractEmbeddedSubtitle(videoWithSubs);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries[0].text).toBe('Hello from embedded subs.');
    expect(entries[1].text).toBe('Second cue.');
  });

  it('returns [] for a video with no subtitle stream', async () => {
    const entries = await extractEmbeddedSubtitle(join(FIXTURES_DIR, 'tiny.mp4'));
    expect(entries).toEqual([]);
  });

  it('returns [] for a non-existent file (errors are non-fatal)', async () => {
    const entries = await extractEmbeddedSubtitle('/nonexistent/file.mp4');
    expect(entries).toEqual([]);
  });
});
