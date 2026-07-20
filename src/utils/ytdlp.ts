import { execFile as execFileCb } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const require = createRequire(import.meta.url);
const ffmpegPath: string = require('ffmpeg-static') as string;

export const YTDLP_MISSING =
  'yt-dlp is not installed — install it ("pip install yt-dlp" or https://github.com/yt-dlp/yt-dlp#installation) to analyze YouTube/Vimeo/TikTok/Instagram/X/Twitch/Dailymotion/Facebook URLs.';

/**
 * Download-only variant. Loom downloads route through here too, and Loom is not
 * in the platform list above — a Loom user would otherwise get a hint naming
 * every platform except the one they used. Separate from YTDLP_MISSING so
 * transcript/metadata failures on a YouTube URL don't mention Loom.
 */
const YTDLP_MISSING_FOR_DOWNLOAD = `${YTDLP_MISSING} It is also what fetches and merges Loom's separate video+audio streams for frame extraction.`;

/** Login-gated failures are fixable with cookies — matched to append the hint. */
const AUTH_ERROR =
  /log[\s-]?in|cookies?|sign in|empty media response|private|age.?restrict|rate.?limit/i;

/**
 * The cookie SOURCE could not be read at all — distinct from "this video needs
 * cookies". Container-verified message: `could not find edge cookies database`.
 * Dropping cookies fixes this class and nothing else, so only it earns a retry.
 */
const COOKIE_SOURCE_UNUSABLE =
  /could not (find|copy|open).{0,40}cookies?|cookies? (database|file).{0,30}(not found|locked|permission|denied)|failed to (decrypt|read|open).{0,20}cookies?|unsupported browser/i;

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

/**
 * Flags every yt-dlp invocation needs. `cookies` is a parameter only so the
 * download retry can drop them — keeping ONE definition, so a flag added here
 * later can't silently skip the download path (that divergence-by-copy is
 * exactly how issue #24 happened, one level up).
 */
export function commonArgs(cookies: string[] = ytdlpCookieArgs()): string[] {
  return ['--no-warnings', '--no-playlist', ...cookies];
}

/**
 * Pull the first `ERROR: ...` line out of yt-dlp's stderr so private /
 * age-restricted / unavailable videos surface as readable warnings. When the
 * failure looks auth-related (common for Instagram/private posts), append a
 * hint pointing at the env vars THIS server reads — yt-dlp's own message only
 * mentions raw `--cookies` CLI flags the MCP user never invokes.
 */
export function extractYtDlpError(err: unknown): string {
  const stderr = (err as { stderr?: string })?.stderr;
  let msg = err instanceof Error ? err.message : String(err);
  if (typeof stderr === 'string') {
    const line = stderr.split(/\r?\n/).find((l) => l.startsWith('ERROR:'));
    if (line) msg = line;
  }
  // With no `ERROR:` line (timeout, SIGKILL, ENOENT) execFile's message is
  // "Command failed: <full argv>", which includes the cookie file path — and
  // these strings reach warnings[], which is returned to the MCP client and
  // usually logged. The path is not a credential but points straight at one.
  msg = msg.replace(/(--cookies(?:-from-browser)?)[= ]\S+/g, '$1 <redacted>');
  // "Set cookies" is circular advice when the cookie SOURCE is what failed —
  // the user already configured it; it's unreadable. Caller says what to do.
  if (COOKIE_SOURCE_UNUSABLE.test(msg)) return msg;
  if (AUTH_ERROR.test(msg)) {
    msg +=
      ' — this content likely requires authentication: set YTDLP_COOKIES=<Netscape cookie file> or YTDLP_COOKIES_FROM_BROWSER=chrome (on Windows the browser must be closed).';
  }
  return msg;
}

/**
 * Picks yt-dlp's merged output out of `destDir`.
 *
 * Deliberately stricter than `startsWith('video.')`. yt-dlp names per-format
 * streams `video.f<id>.<ext>` and in-progress files `.part`/`.ytdl`, and when a
 * merge does not happen it leaves them behind — the issue #24 reporter's
 * environment had `video.fdash-raw-0.webm` (audio) next to
 * `video.fdash-raw-original.webm` (video). A loose glob would return whichever
 * `readdir` listed first, plausibly the audio-only stream: zero frames again,
 * for a new reason.
 */
async function pickDownloadedFile(
  destDir: string,
  onWarning?: (message: string) => void,
): Promise<string | null> {
  let files: string[];
  try {
    files = await readdir(destDir);
  } catch (e: unknown) {
    // The download succeeded; losing it here silently is issue #24's shape.
    onWarning?.(
      `Download completed but the output directory could not be read: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }

  // Merged output may be .mp4/.webm/.mkv depending on the source formats, but
  // it never carries a per-format `.f<id>` infix.
  const merged = files.filter((f) => /^video\.[a-z0-9]+$/i.test(f));
  if (merged.length === 1) return join(destDir, merged[0]);

  const leftovers = files.filter((f) => f.startsWith('video.'));
  if (leftovers.length === 0) {
    onWarning?.(
      'yt-dlp finished without producing a file — live streams are skipped by design (recordings only).',
    );
    return null;
  }

  onWarning?.(
    `yt-dlp left ${leftovers.length} output files (${leftovers.join(', ')}) — the audio and ` +
      `video streams were probably not merged. Check that ffmpeg is available at ${ffmpegPath}.`,
  );
  return null;
}

/**
 * Download a video with yt-dlp into `destDir`, returning the merged file path.
 *
 * THE single yt-dlp download implementation. It lives here rather than in an
 * adapter because both `YtDlpAdapter` and `LoomAdapter` need it, and issue #24
 * was caused by exactly that: a second, divergent copy that hardcoded `.mp4` in
 * its `-o` template and then discarded the (correctly downloaded) `.mp4.webm`.
 *
 * Never rejects — the pipeline calls it without a catch.
 *
 * `timeout` is exposed for callers that have their own fallback and shouldn't
 * wait the full budget before reaching it (LoomAdapter passes 120s).
 */
export async function downloadViaYtDlp(
  url: string,
  destDir: string,
  onWarning?: (message: string) => void,
  timeout = 300000,
): Promise<string | null> {
  const ytDlp = await findYtDlp();
  if (!ytDlp) {
    // Without this the caller only sees "no frames" and has nothing to act on.
    onWarning?.(YTDLP_MISSING_FOR_DOWNLOAD);
    return null;
  }

  const downloadArgs = (cookies: string[]): string[] => [
    '-o',
    // NEVER hardcode an extension here: on a DASH merge yt-dlp appends the real
    // container to the template, so `-o x.mp4` yields `x.mp4.webm`. %(ext)s +
    // pickDownloadedFile keeps the two in sync (issue #24).
    join(destDir, 'video.%(ext)s'),
    ...commonArgs(cookies),
    // Live streams would otherwise record until the timeout kills them.
    '--match-filter',
    '!is_live',
    // Prefers ≤1080p when available (frames/OCR don't need more); sources
    // offering only higher resolutions still download.
    '-S',
    'res:1080',
    // Lets yt-dlp merge DASH video+audio without a system ffmpeg. Without it
    // yt-dlp leaves the streams UNMERGED (verified in a container), which
    // pickDownloadedFile then reports rather than guessing between them.
    '--ffmpeg-location',
    ffmpegPath,
    '-q',
    url,
  ];

  const cookies = ytdlpCookieArgs();
  try {
    await runYtDlp(ytDlp, downloadArgs(cookies), { timeout });
  } catch (err: unknown) {
    const detail = extractYtDlpError(err);
    // Retry ONLY when the cookie source itself is unreadable — that failure
    // kills the whole invocation, so a cookie env var set for one platform
    // breaks downloads everywhere, and public videos don't need cookies.
    // Gating on the cause matters: retrying every failure would double the
    // wall-clock and, for a genuinely private video, would replace the real
    // error with a credential-less "login required" telling the user to
    // configure cookies they already configured.
    if (cookies.length === 0 || !COOKIE_SOURCE_UNUSABLE.test(detail)) {
      onWarning?.(`Video download failed: ${detail}`);
      return null;
    }
    onWarning?.(
      `Cookie source unusable (${detail}) — downloaded without cookies; private or ` +
        `age-restricted videos will still fail until it is fixed.`,
    );
    try {
      await runYtDlp(ytDlp, downloadArgs([]), { timeout });
    } catch (retryErr: unknown) {
      onWarning?.(`Video download failed: ${extractYtDlpError(retryErr)}`);
      return null;
    }
  }

  return pickDownloadedFile(destDir, onWarning);
}
