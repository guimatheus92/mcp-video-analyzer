import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findYtDlp, resetYtDlpLocator, ytdlpCookieArgs } from './ytdlp.js';

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

// Per-test handler: return null to make a probe succeed, an Error to fail it.
let execHandler: (cmd: string, args: string[]) => Error | null = () => new Error('not found');
// Every probe's [cmd, opts] pair, so tests can assert the timeout actually passed.
let execCalls: { cmd: string; opts: { timeout?: number } }[] = [];

vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], opts: unknown, cb?: ExecCallback) => {
    const callback = (typeof opts === 'function' ? opts : cb) as ExecCallback;
    execCalls.push({ cmd, opts: (typeof opts === 'object' ? opts : {}) as { timeout?: number } });
    callback(execHandler(cmd, args), '', '');
  },
}));

describe('findYtDlp', () => {
  beforeEach(() => {
    resetYtDlpLocator();
    execCalls = [];
  });

  afterEach(() => {
    execHandler = () => new Error('not found');
  });

  it('prefers the yt-dlp binary on PATH', async () => {
    execHandler = (cmd) => (cmd === 'yt-dlp' ? null : new Error('not found'));
    expect(await findYtDlp()).toEqual({ bin: 'yt-dlp', prefix: [] });
  });

  it('caches a successful probe for the process lifetime', async () => {
    let probes = 0;
    execHandler = (cmd) => {
      if (cmd === 'yt-dlp') {
        probes++;
        return null;
      }
      return new Error('not found');
    };
    await findYtDlp();
    await findYtDlp();
    expect(probes).toBe(1);
  });

  it('does not cache failures — install-then-retry works without a restart', async () => {
    expect(await findYtDlp()).toBeNull();
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

  // Issue #26: the standalone yt-dlp binary cold-starts in >7s; a 5s probe
  // timeout made a slow-but-present binary look absent. The probe must allow
  // for that cold start, and every probe site must use the same value.
  it('probes with a timeout long enough for the binary cold start (all sites)', async () => {
    await findYtDlp(); // nothing installed → exercises all three probe sites
    expect(execCalls.length).toBeGreaterThanOrEqual(3);
    for (const call of execCalls) {
      expect(call.opts.timeout ?? 0).toBeGreaterThanOrEqual(15_000);
    }
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
