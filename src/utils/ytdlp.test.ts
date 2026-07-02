import { afterEach, describe, expect, it, vi } from 'vitest';
import { findYtDlp, ytdlpCookieArgs } from './ytdlp.js';

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

// Per-test handler: return null to make a probe succeed, an Error to fail it.
let execHandler: (cmd: string, args: string[]) => Error | null = () => new Error('not found');

vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], opts: unknown, cb?: ExecCallback) => {
    const callback = (typeof opts === 'function' ? opts : cb) as ExecCallback;
    callback(execHandler(cmd, args), '', '');
  },
}));

describe('findYtDlp', () => {
  afterEach(() => {
    execHandler = () => new Error('not found');
  });

  it('prefers the yt-dlp binary on PATH', async () => {
    execHandler = (cmd) => (cmd === 'yt-dlp' ? null : new Error('not found'));
    expect(await findYtDlp()).toEqual({ bin: 'yt-dlp', prefix: [] });
  });

  it('falls back to yt-dlp.exe when the bare binary is missing', async () => {
    execHandler = (cmd) => (cmd === 'yt-dlp.exe' ? null : new Error('not found'));
    expect(await findYtDlp()).toEqual({ bin: 'yt-dlp.exe', prefix: [] });
  });

  it('falls back to the python module last', async () => {
    execHandler = (cmd, args) =>
      cmd === 'python' && args.includes('yt_dlp') ? null : new Error('not found');
    expect(await findYtDlp()).toEqual({ bin: 'python', prefix: ['-m', 'yt_dlp'] });
  });

  it('returns null when nothing is installed', async () => {
    expect(await findYtDlp()).toBeNull();
  });
});

describe('ytdlpCookieArgs', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns no flags when neither env var is set', () => {
    vi.stubEnv('YTDLP_COOKIES', '');
    vi.stubEnv('YTDLP_COOKIES_FROM_BROWSER', '');
    expect(ytdlpCookieArgs()).toEqual([]);
  });

  it('maps YTDLP_COOKIES to --cookies', () => {
    vi.stubEnv('YTDLP_COOKIES', 'C:\\cookies.txt');
    vi.stubEnv('YTDLP_COOKIES_FROM_BROWSER', '');
    expect(ytdlpCookieArgs()).toEqual(['--cookies', 'C:\\cookies.txt']);
  });

  it('maps YTDLP_COOKIES_FROM_BROWSER to --cookies-from-browser', () => {
    vi.stubEnv('YTDLP_COOKIES', '');
    vi.stubEnv('YTDLP_COOKIES_FROM_BROWSER', 'chrome');
    expect(ytdlpCookieArgs()).toEqual(['--cookies-from-browser', 'chrome']);
  });

  it('prefers the explicit cookie file when both are set', () => {
    vi.stubEnv('YTDLP_COOKIES', '/tmp/cookies.txt');
    vi.stubEnv('YTDLP_COOKIES_FROM_BROWSER', 'chrome');
    expect(ytdlpCookieArgs()).toEqual(['--cookies', '/tmp/cookies.txt']);
  });
});
