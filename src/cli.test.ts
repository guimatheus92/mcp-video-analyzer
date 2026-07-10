import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestImage } from '../test/helpers/index.js';
import { copyFrames, defaultOutDir, parseCliArgs } from './cli.js';
import type { IFrameResult } from './types.js';

describe('parseCliArgs', () => {
  it('maps flags to analyze options', () => {
    const parsed = parseCliArgs([
      'https://example.com/video.mp4',
      '--detail',
      'brief',
      '--max-frames',
      '10',
      '--fields',
      'metadata, transcript',
      '--force-refresh',
      '--ocr-language',
      'eng',
      '--model',
      'small',
      '--language',
      'pt',
      '--out',
      '/tmp/frames',
    ]);

    expect(parsed.url).toBe('https://example.com/video.mp4');
    expect(parsed.outDir).toBe('/tmp/frames');
    expect(parsed.help).toBe(false);
    expect(parsed.options).toEqual({
      detail: 'brief',
      maxFrames: 10,
      fields: ['metadata', 'transcript'],
      forceRefresh: true,
      ocrLanguage: 'eng',
      model: 'small',
      language: 'pt',
    });
  });

  it('returns undefined options when no flags are given', () => {
    const parsed = parseCliArgs(['https://example.com/video.mp4']);
    expect(parsed.options).toBeUndefined();
    expect(parsed.outDir).toBeUndefined();
  });

  it('sets help for -h without requiring a url', () => {
    expect(parseCliArgs(['-h']).help).toBe(true);
    expect(parseCliArgs(['--help']).help).toBe(true);
  });

  it('rejects a non-numeric --max-frames', () => {
    expect(() => parseCliArgs(['url', '--max-frames', 'abc'])).toThrow();
  });

  it('rejects an out-of-range --max-frames', () => {
    expect(() => parseCliArgs(['url', '--max-frames', '999'])).toThrow();
  });

  it('rejects an invalid --detail level', () => {
    expect(() => parseCliArgs(['url', '--detail', 'wrong'])).toThrow();
  });

  it('rejects an unknown --fields entry', () => {
    expect(() => parseCliArgs(['url', '--fields', 'bogus'])).toThrow();
  });

  it('rejects unknown flags', () => {
    expect(() => parseCliArgs(['url', '--nope'])).toThrow();
  });
});

describe('defaultOutDir', () => {
  it('is stable for the same source and distinct across sources', () => {
    const a = defaultOutDir('https://example.com/a.mp4');
    expect(defaultOutDir('https://example.com/a.mp4')).toBe(a);
    expect(defaultOutDir('https://example.com/b.mp4')).not.toBe(a);
    expect(a).toContain('mcp-video-analyzer');
  });
});

describe('copyFrames', () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'cli-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('copies frames to the out dir, rewriting paths and counting missing sources', async () => {
    const srcDir = await makeTempDir();
    const outDir = join(await makeTempDir(), 'frames');

    const frames: IFrameResult[] = [
      {
        time: '0:00',
        filePath: await createTestImage(srcDir, 'frame_0001.jpg'),
        mimeType: 'image/jpeg',
      },
      {
        time: '0:05',
        filePath: await createTestImage(srcDir, 'frame_0002.jpg'),
        mimeType: 'image/jpeg',
      },
      { time: '0:10', filePath: join(srcDir, 'frame_gone.jpg'), mimeType: 'image/jpeg' },
    ];

    const { frames: copied, missing } = await copyFrames(frames, outDir);

    expect(missing).toBe(1);
    expect(copied).toHaveLength(2);
    expect(copied.map((f) => f.time)).toEqual(['0:00', '0:05']);
    for (const frame of copied) {
      expect(frame.filePath.startsWith(outDir)).toBe(true);
      await expect(stat(frame.filePath)).resolves.toBeDefined();
    }
  });
});
