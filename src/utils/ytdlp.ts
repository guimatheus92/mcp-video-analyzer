import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export interface YtDlpCommand {
  bin: string;
  prefix: string[];
}

/**
 * Locate a usable yt-dlp invocation: the binary on PATH (`yt-dlp` /
 * `yt-dlp.exe`), falling back to the Python module. Returns null when none
 * is available — callers degrade with a warning instead of throwing.
 */
export async function findYtDlp(): Promise<YtDlpCommand | null> {
  for (const bin of ['yt-dlp', 'yt-dlp.exe']) {
    try {
      await execFile(bin, ['--version'], { timeout: 5000 });
      return { bin, prefix: [] };
    } catch {
      // not found, try next
    }
  }

  // Try python module
  try {
    await execFile('python', ['-m', 'yt_dlp', '--version'], { timeout: 5000 });
    return { bin: 'python', prefix: ['-m', 'yt_dlp'] };
  } catch {
    return null;
  }
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
