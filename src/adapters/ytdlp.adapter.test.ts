import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURES_DIR } from '../../test/helpers/index.js';
import { cleanupTempDir, createTempDir } from '../utils/temp-files.js';
import { resetYtDlpLocator } from '../utils/ytdlp.js';
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
  // async so a synchronous throw from the handler becomes a rejection —
  // Node's real promisified execFile never throws synchronously.
  (execFile as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] =
    async (cmd: string, args: string[]) => execHandler(cmd, args);
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
    resetYtDlpLocator();
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

    it('shares one -J process between concurrent getMetadata and getChapters', async () => {
      let jCalls = 0;
      execHandler = fixtureHandler(() => {
        jCalls++;
      });
      const freshAdapter = new YtDlpAdapter();
      const [meta, chapters] = await Promise.all([
        freshAdapter.getMetadata('https://youtu.be/abc123'),
        freshAdapter.getChapters('https://youtu.be/abc123'),
      ]);
      expect(meta.title).toBe('Sample YouTube Video');
      expect(chapters).toHaveLength(3);
      expect(jCalls).toBe(1);
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

    it('throws the yt-dlp ERROR when both passes fail (not mislabeled as captionless)', async () => {
      execHandler = (_cmd, args) => {
        if (args.includes('--version')) return ok();
        throw Object.assign(new Error('Command failed'), {
          stderr: 'ERROR: Sign in to confirm your age\n',
        });
      };
      await expect(adapter.getTranscript('https://youtu.be/abc123')).rejects.toThrow(
        'ERROR: Sign in to confirm your age',
      );
    });

    it('prefers the WHISPER_LANGUAGE subtitle when multiple are on disk', async () => {
      vi.stubEnv('WHISPER_LANGUAGE', 'pt');
      let subLangs = '';
      execHandler = (_cmd, args) => {
        if (args.includes('--version')) return ok();
        if (args.includes('--skip-download')) {
          subLangs = args[args.indexOf('--sub-langs') + 1];
          const outBase = args[args.indexOf('-o') + 1];
          writeFileSync(
            `${outBase}.en.vtt`,
            'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello world\n',
          );
          writeFileSync(
            `${outBase}.pt.vtt`,
            'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nOlá mundo\n',
          );
          return ok();
        }
        throw new Error('unexpected');
      };

      const transcript = await adapter.getTranscript('https://youtu.be/abc123');
      expect(transcript.map((e) => e.text)).toEqual(['Olá mundo']);
      expect(subLangs).toBe('pt.*,en.*');
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

    // Regression: issue #24. A DASH source with separate video+audio streams
    // merges to webm, and yt-dlp appends the real container to the -o template.
    // The old Loom code passed `-o <id>.mp4` and then checked for `<id>.mp4`,
    // so a 44MB download was silently discarded.
    it('returns the merged file when the container is not mp4 (DASH webm merge)', async () => {
      const tempDir = await createTempDir();
      try {
        let captured: string[] = [];
        execHandler = (_cmd, args) => {
          if (args.includes('--version')) return ok();
          captured = args;
          const outTemplate = args[args.indexOf('-o') + 1];
          writeFileSync(outTemplate.replace('%(ext)s', 'webm'), 'fake merged webm');
          return ok();
        };

        const path = await adapter.downloadVideo('https://www.loom.com/share/abc123', tempDir);
        expect(path).toBe(join(tempDir, 'video.webm'));
        // The template must stay extension-agnostic — a literal extension is
        // what caused #24.
        expect(captured[captured.indexOf('-o') + 1]).toContain('%(ext)s');
      } finally {
        await cleanupTempDir(tempDir);
      }
    });

    // Without --ffmpeg-location, yt-dlp cannot merge DASH streams in our
    // published image (no system ffmpeg) and leaves them UNMERGED — the glob
    // above would then return the audio-only file. Verified in a container.
    it('points yt-dlp at the bundled ffmpeg so DASH merging works without a system ffmpeg', async () => {
      const tempDir = await createTempDir();
      try {
        let captured: string[] = [];
        execHandler = (_cmd, args) => {
          if (args.includes('--version')) return ok();
          captured = args;
          writeFileSync(args[args.indexOf('-o') + 1].replace('%(ext)s', 'webm'), 'v');
          return ok();
        };
        await adapter.downloadVideo('https://youtu.be/abc123', tempDir);

        const location = captured[captured.indexOf('--ffmpeg-location') + 1];
        expect(captured).toContain('--ffmpeg-location');
        expect(existsSync(location)).toBe(true);
      } finally {
        await cleanupTempDir(tempDir);
      }
    });

    it('returns null when the download fails, reporting the reason via onWarning', async () => {
      const tempDir = await createTempDir();
      try {
        execHandler = (_cmd, args) => {
          if (args.includes('--version')) return ok();
          throw Object.assign(new Error('Command failed'), {
            stderr: 'ERROR: Requested format is not available\n',
          });
        };
        const warnings: string[] = [];
        const path = await adapter.downloadVideo('https://youtu.be/abc123', tempDir, (w) =>
          warnings.push(w),
        );
        expect(path).toBeNull();
        expect(warnings.join(' ')).toContain('ERROR: Requested format is not available');
        // A plain format error is not auth-related — no cookie hint appended.
        expect(warnings.join(' ')).not.toContain('YTDLP_COOKIES');
      } finally {
        await cleanupTempDir(tempDir);
      }
    });

    it('appends a cookie hint when the download fails with a login-gated error', async () => {
      const tempDir = await createTempDir();
      try {
        execHandler = (_cmd, args) => {
          if (args.includes('--version')) return ok();
          throw Object.assign(new Error('Command failed'), {
            stderr: 'ERROR: [Instagram] abc: Instagram sent an empty media response.\n',
          });
        };
        const warnings: string[] = [];
        await adapter.downloadVideo('https://www.instagram.com/reel/abc/', tempDir, (w) =>
          warnings.push(w),
        );
        expect(warnings.join(' ')).toContain('empty media response');
        expect(warnings.join(' ')).toContain('YTDLP_COOKIES');
      } finally {
        await cleanupTempDir(tempDir);
      }
    });

    it('warns about skipped live streams when yt-dlp succeeds without a file', async () => {
      const tempDir = await createTempDir();
      try {
        execHandler = (_cmd, args) => {
          if (args.includes('--version')) return ok();
          return ok(); // exit 0, no file written — the --match-filter !is_live case
        };
        const warnings: string[] = [];
        const path = await adapter.downloadVideo('https://youtu.be/abc123', tempDir, (w) =>
          warnings.push(w),
        );
        expect(path).toBeNull();
        expect(warnings.join(' ')).toContain('live streams are skipped');
      } finally {
        await cleanupTempDir(tempDir);
      }
    });

    it('returns null when yt-dlp is missing (never rejects)', async () => {
      expect(await adapter.downloadVideo('https://youtu.be/abc123', 'C:\\nowhere')).toBeNull();
    });

    // Otherwise the caller only sees "no frames" with nothing to act on — the
    // exact complaint in issue #24. Loom is named because LoomAdapter delegates
    // its download here.
    it('reports the install hint via onWarning when yt-dlp is missing', async () => {
      const warnings: string[] = [];
      await adapter.downloadVideo('https://www.loom.com/share/abc123', 'C:\\nowhere', (w) =>
        warnings.push(w),
      );
      expect(warnings.join(' ')).toContain('yt-dlp is not installed');
      expect(warnings.join(' ')).toContain('Loom');
    });

    // An unreadable cookie source fails the WHOLE yt-dlp invocation (verified
    // in a container: "could not find edge cookies database"), so a cookie env
    // var set for Instagram would otherwise break every other platform too.
    it('retries without cookies when the cookie source is unusable', async () => {
      vi.stubEnv('YTDLP_COOKIES_FROM_BROWSER', 'edge');
      const tempDir = await createTempDir();
      try {
        const attempts: string[][] = [];
        execHandler = (_cmd, args) => {
          if (args.includes('--version')) return ok();
          attempts.push(args);
          if (args.includes('--cookies-from-browser')) {
            throw Object.assign(new Error('Command failed'), {
              stderr: 'ERROR: could not find edge cookies database\n',
            });
          }
          writeFileSync(args[args.indexOf('-o') + 1].replace('%(ext)s', 'webm'), 'v');
          return ok();
        };

        const warnings: string[] = [];
        const path = await adapter.downloadVideo('https://youtu.be/abc123', tempDir, (w) =>
          warnings.push(w),
        );

        expect(path).toBe(join(tempDir, 'video.webm'));
        expect(attempts).toHaveLength(2);
        expect(attempts[1]).not.toContain('--cookies-from-browser');
        // Surfaced even though the download succeeded — it's the only signal
        // the user's cookie source is broken. Worded as a diagnosis, not a
        // failure, so a successful run doesn't look like a failed one.
        expect(warnings.join(' ')).toContain('Cookie source unusable');
        expect(warnings.join(' ')).toContain('downloaded without cookies');
        // No "set YTDLP_COOKIES=..." hint here: the user already set it and it
        // is unreadable. Telling them to set it is the #24 misdirection class.
        expect(warnings.join(' ')).not.toContain('set YTDLP_COOKIES=');
      } finally {
        await cleanupTempDir(tempDir);
      }
    });

    // Retrying every failure would double the wall-clock and, for a genuinely
    // private video, replace the real error with a credential-less "login
    // required" that tells the user to configure cookies they already have.
    it('does not retry when the failure is unrelated to the cookie source', async () => {
      vi.stubEnv('YTDLP_COOKIES_FROM_BROWSER', 'edge');
      const tempDir = await createTempDir();
      try {
        let calls = 0;
        execHandler = (_cmd, args) => {
          if (args.includes('--version')) return ok();
          calls += 1;
          throw Object.assign(new Error('Command failed'), {
            stderr: 'ERROR: Private video. Sign in if you have been granted access\n',
          });
        };
        const warnings: string[] = [];
        const path = await adapter.downloadVideo('https://youtu.be/abc123', tempDir, (w) =>
          warnings.push(w),
        );

        expect(path).toBeNull();
        expect(calls).toBe(1);
        // The real reason survives, with the cookie hint that actually helps.
        expect(warnings.join(' ')).toContain('Private video');
        expect(warnings.join(' ')).toContain('YTDLP_COOKIES');
        expect(warnings.join(' ')).not.toContain('downloaded without cookies');
      } finally {
        await cleanupTempDir(tempDir);
      }
    });

    it('reports the underlying failure when the cookie-free retry also fails', async () => {
      vi.stubEnv('YTDLP_COOKIES_FROM_BROWSER', 'edge');
      const tempDir = await createTempDir();
      try {
        let calls = 0;
        execHandler = (_cmd, args) => {
          if (args.includes('--version')) return ok();
          calls += 1;
          throw Object.assign(new Error('Command failed'), {
            stderr: args.includes('--cookies-from-browser')
              ? 'ERROR: could not find edge cookies database\n'
              : 'ERROR: Requested format is not available\n',
          });
        };
        const warnings: string[] = [];
        const path = await adapter.downloadVideo('https://youtu.be/abc123', tempDir, (w) =>
          warnings.push(w),
        );

        expect(path).toBeNull();
        expect(calls).toBe(2);
        expect(warnings.join(' ')).toContain('Requested format is not available');
      } finally {
        await cleanupTempDir(tempDir);
      }
    });

    // The reporter's environment produced exactly this state. A loose
    // `startsWith('video.')` glob would return whichever readdir listed first
    // — plausibly the 2.8MB audio stream: zero frames again, new cause.
    it('refuses to return an unmerged stream when yt-dlp could not merge', async () => {
      const tempDir = await createTempDir();
      try {
        execHandler = (_cmd, args) => {
          if (args.includes('--version')) return ok();
          const stem = args[args.indexOf('-o') + 1].replace('.%(ext)s', '');
          writeFileSync(`${stem}.fdash-raw-0.webm`, 'audio');
          writeFileSync(`${stem}.fdash-raw-original.webm`, 'video-much-larger');
          return ok();
        };
        const warnings: string[] = [];
        const path = await adapter.downloadVideo('https://youtu.be/abc123', tempDir, (w) =>
          warnings.push(w),
        );

        expect(path).toBeNull();
        expect(warnings.join(' ')).toContain('not merged');
      } finally {
        await cleanupTempDir(tempDir);
      }
    });

    it('ignores in-progress .part files left by a previous attempt', async () => {
      const tempDir = await createTempDir();
      try {
        execHandler = (_cmd, args) => {
          if (args.includes('--version')) return ok();
          const stem = args[args.indexOf('-o') + 1].replace('.%(ext)s', '');
          writeFileSync(`${stem}.f251.webm.part`, 'partial');
          writeFileSync(`${stem}.webm`, 'merged');
          return ok();
        };
        const path = await adapter.downloadVideo('https://youtu.be/abc123', tempDir);
        expect(path).toBe(join(tempDir, 'video.webm'));
      } finally {
        await cleanupTempDir(tempDir);
      }
    });

    // With no `ERROR:` line (timeout/SIGKILL/ENOENT) execFile's message is the
    // full argv. These strings reach warnings[], which goes to the MCP client
    // and is usually logged — and LoomAdapter now forwards them where it
    // previously swallowed them, so the exposure got wider, not narrower.
    it('redacts the cookie file path from argv-style failures', async () => {
      vi.stubEnv('YTDLP_COOKIES', 'C:/secrets/loom-cookies.txt');
      const tempDir = await createTempDir();
      try {
        execHandler = (_cmd, args) => {
          if (args.includes('--version')) return ok();
          // No stderr ERROR: line — the fallback path.
          throw new Error(
            'Command failed: yt-dlp --cookies C:/secrets/loom-cookies.txt -o /tmp/video.%(ext)s https://youtu.be/abc123',
          );
        };
        const warnings: string[] = [];
        await adapter.downloadVideo('https://youtu.be/abc123', tempDir, (w) => warnings.push(w));

        expect(warnings.join(' ')).not.toContain('C:/secrets/loom-cookies.txt');
        expect(warnings.join(' ')).toContain('<redacted>');
      } finally {
        await cleanupTempDir(tempDir);
      }
    });

    it('does not retry when no cookies were configured', async () => {
      const tempDir = await createTempDir();
      try {
        let calls = 0;
        execHandler = (_cmd, args) => {
          if (args.includes('--version')) return ok();
          calls += 1;
          throw Object.assign(new Error('Command failed'), { stderr: 'ERROR: nope\n' });
        };
        expect(await adapter.downloadVideo('https://youtu.be/abc123', tempDir)).toBeNull();
        expect(calls).toBe(1);
      } finally {
        await cleanupTempDir(tempDir);
      }
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

  it('never trims mid-word: "…same liNE" × "NExt line…" stays intact', () => {
    const entries = [
      { time: '0:00', text: 'on the same line' },
      { time: '0:02', text: 'next line here' },
    ];
    expect(collapseRollingCaptions(entries).map((e) => e.text)).toEqual([
      'on the same line',
      'next line here',
    ]);
  });
});
