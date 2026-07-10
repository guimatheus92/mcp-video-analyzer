import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestImage } from '../test/helpers/index.js';
import { copyFrames, defaultOutDir, parseCliArgs, runCli } from './cli.js';
import { getAnalysis } from './tools/analyze-core.js';
import type * as analyzeCore from './tools/analyze-core.js';
import type { IAnalysisResult, IFrameResult } from './types.js';

vi.mock('./tools/analyze-core.js', async (importOriginal) => {
  const actual = await importOriginal<typeof analyzeCore>();
  return { ...actual, getAnalysis: vi.fn(actual.getAnalysis) };
});

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

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cli-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
  vi.restoreAllMocks();
});

describe('copyFrames', () => {
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

    const { frames: copied, missing, errors } = await copyFrames(frames, outDir);

    expect(missing).toBe(1);
    expect(errors).toEqual([]);
    expect(copied).toHaveLength(2);
    expect(copied.map((f) => f.time)).toEqual(['0:00', '0:05']);
    for (const frame of copied) {
      expect(frame.filePath.startsWith(outDir)).toBe(true);
      await expect(stat(frame.filePath)).resolves.toBeDefined();
    }
  });

  it('reports non-ENOENT copy failures as errors, not as missing frames', async () => {
    const srcDir = await makeTempDir();
    const outDir = await makeTempDir();

    const framePath = await createTestImage(srcDir, 'frame_0001.jpg');
    // A directory occupying the destination path forces a non-ENOENT failure
    // (EPERM/EISDIR depending on platform).
    await mkdir(join(outDir, 'frame_0001.jpg'));

    const { frames, missing, errors } = await copyFrames(
      [{ time: '0:00', filePath: framePath, mimeType: 'image/jpeg' }],
      outDir,
    );

    expect(frames).toEqual([]);
    expect(missing).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Frame copy to');
    expect(errors[0]).not.toContain('force-refresh');
  });
});

describe('runCli', () => {
  function captureStreams(): { stdout: () => string; stderr: () => string } {
    let out = '';
    let err = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err += String(chunk);
      return true;
    });
    return { stdout: () => out, stderr: () => err };
  }

  function fakeResult(frames: IFrameResult[]): IAnalysisResult {
    return {
      metadata: {
        platform: 'local',
        title: 'fake',
        duration: 1,
        durationFormatted: '0:01',
        url: 'C:/videos/fake.mp4',
      },
      transcript: [],
      frames,
      comments: [],
      chapters: [],
      ocrResults: [],
      timeline: [],
      warnings: ['base warning'],
    };
  }

  it('exits 1 with stderr only when the analysis hard-fails', async () => {
    const streams = captureStreams();
    vi.mocked(getAnalysis).mockRejectedValueOnce(new Error('pipeline exploded'));

    const code = await runCli([join(tmpdir(), 'whatever.mp4')]);

    expect(code).toBe(1);
    expect(streams.stdout()).toBe('');
    expect(streams.stderr()).toContain('pipeline exploded');
  });

  it('degrades a failed frame copy into warnings, still runs cleanup and exits 0', async () => {
    const streams = captureStreams();
    const cleanup = vi.fn(async () => undefined);
    const srcDir = await makeTempDir();
    const framePath = await createTestImage(srcDir, 'frame_0001.jpg');
    vi.mocked(getAnalysis).mockResolvedValueOnce({
      result: fakeResult([{ time: '0:00', filePath: framePath, mimeType: 'image/jpeg' }]),
      cleanup,
    });
    // An --out whose parent is a FILE makes copyFrames' mkdir reject.
    const bogusOut = join(framePath, 'sub');

    const code = await runCli([join(tmpdir(), 'whatever.mp4'), '--out', bogusOut]);

    expect(code).toBe(0);
    expect(cleanup).toHaveBeenCalled();
    const doc = JSON.parse(streams.stdout());
    expect(doc.frames).toEqual([]);
    expect(doc.warnings).toContain('base warning');
    expect(doc.warnings.some((w: string) => w.includes('Frame images could not be copied'))).toBe(
      true,
    );
  });

  it('appends the missing-frames warning when source frames are already gone', async () => {
    const streams = captureStreams();
    const cleanup = vi.fn(async () => undefined);
    const srcDir = await makeTempDir();
    vi.mocked(getAnalysis).mockResolvedValueOnce({
      result: fakeResult([
        { time: '0:00', filePath: join(srcDir, 'frame_gone.jpg'), mimeType: 'image/jpeg' },
      ]),
      cleanup,
    });

    const code = await runCli([
      join(tmpdir(), 'whatever.mp4'),
      '--out',
      join(await makeTempDir(), 'frames'),
    ]);

    expect(code).toBe(0);
    expect(cleanup).toHaveBeenCalled();
    const doc = JSON.parse(streams.stdout());
    expect(doc.frames).toEqual([]);
    expect(doc.frameCount).toBe(1);
    expect(
      doc.warnings.some((w: string) => w.includes('1 of 1 frame image(s) were unavailable')),
    ).toBe(true);
    expect(doc.warnings.some((w: string) => w.includes('--force-refresh'))).toBe(true);
  });
});
