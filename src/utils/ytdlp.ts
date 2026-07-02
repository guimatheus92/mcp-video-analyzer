import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export interface YtDlpCommand {
  bin: string;
  prefix: string[];
}

// Positive probe result cached per process. Failures are NOT cached, so
// "install yt-dlp and retry" works without a server restart — and a transient
// probe hiccup in one adapter method can't silently drop a later strategy.
let located: YtDlpCommand | null = null;

/** Test hook: clears the positive probe cache. */
export function resetYtDlpLocator(): void {
  located = null;
}

/**
 * Locate a usable yt-dlp invocation: the binary on PATH (`yt-dlp` /
 * `yt-dlp.exe`), falling back to the Python module. Returns null when none is
 * available — `downloadVideo` then degrades to null, while transcript/metadata
 * paths throw an install-hint error that the tool handlers convert into a
 * `warnings[]` entry.
 */
export async function findYtDlp(): Promise<YtDlpCommand | null> {
  if (located) return located;

  for (const bin of ['yt-dlp', 'yt-dlp.exe']) {
    try {
      await execFile(bin, ['--version'], { timeout: 5000 });
      located = { bin, prefix: [] };
      return located;
    } catch {
      // not found, try next
    }
  }

  // Try python module
  try {
    await execFile('python', ['-m', 'yt_dlp', '--version'], { timeout: 5000 });
    located = { bin: 'python', prefix: ['-m', 'yt_dlp'] };
    return located;
  } catch {
    return null;
  }
}

/**
 * Spawn yt-dlp through the located command. The single place that owns the
 * bin/prefix pairing, so no call site can forget `...prefix` (which would
 * silently break python-module installs only).
 */
export function runYtDlp(
  cmd: YtDlpCommand,
  args: string[],
  opts: { timeout: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  return execFile(cmd.bin, [...cmd.prefix, ...args], opts);
}

/**
 * Cookie flags for yt-dlp from env — needed for Instagram, age-restricted and
 * other login-gated videos. An explicit cookie file (`YTDLP_COOKIES`, Netscape
 * format) wins over `YTDLP_COOKIES_FROM_BROWSER` (e.g. "chrome") when both are set.
 */
export function ytdlpCookieArgs(): string[] {
  const file = process.env.YTDLP_COOKIES?.trim();
  if (file) return ['--cookies', file];
  const browser = process.env.YTDLP_COOKIES_FROM_BROWSER?.trim();
  if (browser) return ['--cookies-from-browser', browser];
  return [];
}
