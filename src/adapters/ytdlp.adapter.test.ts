import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURES_DIR } from '../../test/helpers/index.js';
import { cleanupTempDir, createTempDir } from '../utils/temp-files.js';
import { YtDlpAdapter, collapseRollingCaptions } from './ytdlp.adapter.js';

interface ExecResult {
  stdout: string;
  stderr: string;
}

// Per-test handler: resolve to fake yt-dlp output, throw to fail the call.
// Mocked through promisify.custom so `const { stdout } = await execFile(...)`
// behaves exactly like Node's real promisified execFile.
let execHandler: (cmd: string, args: string[]) => Promise<ExecResult> = () => {
  throw new Error('not found');
};

vi.mock('node:child_process', () => {
  const execFile = () => {
    throw new Error('callback execFile path not used in these tests');
  };
  (execFile as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] = (
    cmd: string,
    args: string[],
  ) => execHandler(cmd, args);
  return { execFile };
});

const infoFixture = readFileSync(join(FIXTURES_DIR, 'ytdlp-info.json'), 'utf-8');

const ok = (stdout = ''): Promise<ExecResult> => Promise.resolve({ stdout, stderr: '' });

/** Handler where yt-dlp exists and -J returns the fixture. */
function fixtureHandler(onArgs?: (args: string[]) => void) {
  return (_cmd: string, args: string[]): Promise<ExecResult> => {
    if (args.includes('--version')) return ok();
    if (args.includes('-J')) {
      onArgs?.(args);
      return ok(infoFixture);
    }
    throw new Error(`unexpected yt-dlp invocation: ${args.join(' ')}`);
  };
}

const UPLOADED_VTT = `WEBVTT

00:00:01.000 --> 00:00:03.000
Hello world

00:00:03.000 --> 00:00:05.000
Second line
`;

const ROLLING_VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
hello world

00:00:02.000 --> 00:00:04.000
hello world this is

00:00:04.000 --> 00:00:06.000
this is a test
`;

describe('YtDlpAdapter', () => {
  const adapter = new YtDlpAdapter();

  beforeEach(() => {
    // Isolate from whatever the host machine has configured.
    vi.stubEnv('YTDLP_COOKIES', '');
    vi.stubEnv('YTDLP_COOKIES_FROM_BROWSER', '');
    vi.stubEnv('WHISPER_LANGUAGE', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    execHandler = () => {
      throw new Error('not found');
    };
  });

  describe('canHandle', () => {
    it('accepts platform video pages', () => {
      expect(adapter.canHandle('https://www.youtube.com/watch?v=abc123')).toBe(true);
      expect(adapter.canHandle('https://www.instagram.com/reel/AbC123/')).toBe(true);
    });

    it('rejects Loom, direct, and local sources', () => {
      expect(adapter.canHandle('https://www.loom.com/share/abc123')).toBe(false);
      expect(adapter.canHandle('https://example.com/video.mp4')).toBe(false);
      expect(adapter.canHandle('C:\\videos\\clip.mp4')).toBe(false);
    });
  });

  describe('getMetadata', () => {
    it('maps yt-dlp -J fields onto IVideoMetadata', async () => {
      execHandler = fixtureHandler();
      const meta = await adapter.getMetadata('https://www.youtube.com/watch?v=abc123XYZ');

      expect(meta.platform).toBe('ytdlp');
      expect(meta.title).toBe('Sample YouTube Video');
      expect(meta.duration).toBe(212);
      expect(meta.durationFormatted).toBe('3:32');
      expect(meta.uploader).toBe('Sample Channel');
      expect(meta.viewCount).toBe(123456);
      expect(meta.creationTime).toBe('2024-01-15');
      expect(meta.width).toBe(1920);
      expect(meta.fps).toBe(30);
    });

    it('rejects with an install hint when yt-dlp is missing', async () => {
      await expect(adapter.getMetadata('https://youtu.be/abc123')).rejects.toThrow(
        'yt-dlp is not installed',
      );
    });

    it('surfaces the yt-dlp ERROR line for private/unavailable videos', async () => {
      execHandler = (_cmd, args) => {
        if (args.includes('--version')) return ok();
        throw Object.assign(new Error('Command failed'), {
          stderr: 'WARNING: something\nERROR: Private video. Sign in if you have access.\n',
        });
      };
      await expect(adapter.getMetadata('https://youtu.be/abc123')).rejects.toThrow(
        'ERROR: Private video',
      );
    });

    it('passes cookie flags from env to yt-dlp', async () => {
      vi.stubEnv('YTDLP_COOKIES_FROM_BROWSER', 'chrome');
      let captured: string[] = [];
      execHandler = fixtureHandler((args) => {
        captured = args;
      });
      await adapter.getMetadata('https://youtu.be/abc123');

      const idx = captured.indexOf('--cookies-from-browser');
      expect(idx).toBeGreaterThan(-1);
      expect(captured[idx + 1]).toBe('chrome');
    });
  });

  describe('getTranscript', () => {
    it('uses uploaded subtitles without requesting auto-subs', async () => {
      const autoSubCalls: string[][] = [];
      execHandler = (_cmd, args) => {
        if (args.includes('--version')) return ok();
        if (args.includes('--write-auto-subs')) autoSubCalls.push(args);
        if (args.includes('--skip-download')) {
          const outBase = args[args.indexOf('-o') + 1];
          writeFileSync(`${outBase}.en.vtt`, UPLOADED_VTT);
          return ok();
        }
        throw new Error('unexpected');
      };

      const transcript = await adapter.getTranscript('https://youtu.be/abc123');
      expect(transcript.map((e) => e.text)).toEqual(['Hello world', 'Second line']);
      expect(autoSubCalls).toEqual([]);
    });

    it('falls back to auto-subs and collapses rolling duplicates', async () => {
      execHandler = (_cmd, args) => {
        if (args.includes('--version')) return ok();
        if (args.includes('--skip-download')) {
          if (args.includes('--write-auto-subs')) {
            const outBase = args[args.indexOf('-o') + 1];
            writeFileSync(`${outBase}.en.vtt`, ROLLING_VTT);
          }
          return ok();
        }
        throw new Error('unexpected');
      };

      const transcript = await adapter.getTranscript('https://youtu.be/abc123');
      expect(transcript.map((e) => e.text)).toEqual(['hello world', 'this is', 'a test']);
    });

    it('returns [] when the video has no captions (Whisper fallback territory)', async () => {
      execHandler = (_cmd, args) => {
        if (args.includes('--version')) return ok();
        if (args.includes('--skip-download')) return ok();
        throw new Error('unexpected');
      };
      expect(await adapter.getTranscript('https://youtu.be/abc123')).toEqual([]);
    });

    it('rejects with an install hint when yt-dlp is missing', async () => {
      await expect(adapter.getTranscript('https://youtu.be/abc123')).rejects.toThrow(
        'yt-dlp is not installed',
      );
    });
  });

  describe('getChapters', () => {
    it('maps chapters from -J output', async () => {
      execHandler = fixtureHandler();
      expect(await adapter.getChapters('https://youtu.be/abc123')).toEqual([
        { time: '0:00', title: 'Intro' },
        { time: '1:05', title: 'Main topic' },
        { time: '3:10', title: 'Wrap-up' },
      ]);
    });

    it('returns [] quietly when yt-dlp is missing', async () => {
      expect(await adapter.getChapters('https://youtu.be/abc123')).toEqual([]);
    });
  });

  describe('downloadVideo', () => {
    it('returns the downloaded file path and passes safety flags', async () => {
      const tempDir = await createTempDir();
      try {
        let captured: string[] = [];
        execHandler = (_cmd, args) => {
          if (args.includes('--version')) return ok();
          captured = args;
          const outTemplate = args[args.indexOf('-o') + 1];
          writeFileSync(outTemplate.replace('%(ext)s', 'mp4'), 'fake video');
          return ok();
        };

        const path = await adapter.downloadVideo('https://youtu.be/abc123', tempDir);
        expect(path).toBe(join(tempDir, 'video.mp4'));
        expect(captured).toContain('--no-playlist');
        expect(captured.join(' ')).toContain('--match-filter !is_live');
      } finally {
        await cleanupTempDir(tempDir);
      }
    });

    it('returns null when the download fails', async () => {
      const tempDir = await createTempDir();
      try {
        execHandler = (_cmd, args) => {
          if (args.includes('--version')) return ok();
          throw new Error('network error');
        };
        expect(await adapter.downloadVideo('https://youtu.be/abc123', tempDir)).toBeNull();
      } finally {
        await cleanupTempDir(tempDir);
      }
    });

    it('returns null when yt-dlp is missing (never rejects)', async () => {
      expect(await adapter.downloadVideo('https://youtu.be/abc123', 'C:\\nowhere')).toBeNull();
    });
  });
});

describe('collapseRollingCaptions', () => {
  it('trims the overlap between consecutive rolling cues', () => {
    const entries = [
      { time: '0:00', text: 'hello world' },
      { time: '0:02', text: 'hello world this is' },
      { time: '0:04', text: 'this is a test' },
    ];
    expect(collapseRollingCaptions(entries).map((e) => e.text)).toEqual([
      'hello world',
      'this is',
      'a test',
    ]);
  });

  it('drops exact consecutive duplicates and empty cues', () => {
    const entries = [
      { time: '0:00', text: 'same line' },
      { time: '0:02', text: 'same line' },
      { time: '0:04', text: '   ' },
      { time: '0:06', text: 'next line' },
    ];
    expect(collapseRollingCaptions(entries).map((e) => e.text)).toEqual(['same line', 'next line']);
  });
});
