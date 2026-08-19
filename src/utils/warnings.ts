/**
 * The one translator between a caught error and `warnings[]`.
 *
 * `warnings[]` is public output: it is returned to the MCP client, lands in the
 * agent's context, and under `MCP_WRITE_SIDECARS=1` is written next to the
 * user's video. Nothing used to constrain what went into it, so a spawned
 * binary's `e.message` — for `execFile` that is `Command failed: <full argv>`
 * plus the whole stderr — arrived verbatim: hundreds of lines carrying absolute
 * local paths. A video-only clip answered "no audio track" with ~300 lines of
 * ffmpeg banner (issue #46).
 *
 * This is the third time the repo solves that. `ffmpegCrashReason()`
 * (frame-extractor.ts, from #26) and `extractYtDlpError()` (ytdlp.ts) each
 * fixed one path; both still apply where they are, and this covers everything
 * else. `src/utils/warning-sources.test.ts` fails the build if a new emitter
 * skips it.
 */

/** Beyond this a warning stops being readable and starts being a log dump. */
const MAX_LENGTH = 300;

/**
 * Windows (`C:\Users\…`) and POSIX (`/tmp/…`) absolute paths.
 *
 * Both halves are written to spare a URL, which in a warning is the user's own
 * input and the most useful thing on the line, unlike a temp path: the POSIX
 * half refuses a `/` preceded by `:`, `/` or a word character (the second slash
 * of `https://` is preceded by the first), and the drive-letter half refuses a
 * letter before it — without that the `s:/` in `https://` reads as a Windows
 * drive and the URL comes out as `http<path>`.
 */
const ABSOLUTE_PATH = /(?:(?<![A-Za-z])[A-Za-z]:[\\/]|(?<![:\w/])\/)[^\s"'`,;)]*[^\s"'`,;).:]/g;

/** Lines a spawned tool writes when it is actually reporting the failure. */
const ERROR_LINE = /\b(error|failed|cannot|could not|no such|not found|invalid|denied)\b/i;

/** Node's own preamble, which is the argv and never the reason. */
const COMMAND_PREAMBLE = /^Command failed:/;

/**
 * The line that actually says what went wrong.
 *
 * Scanned from the end: ffmpeg and whisper both print a version banner and a
 * stream dump before the failure, and `execFile` puts its argv preamble first
 * and the tool's own stderr after it — so the earliest matching line is
 * reliably the least informative one.
 */
function reasonLine(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !COMMAND_PREAMBLE.test(l));
  if (lines.length === 0) return null;
  return [...lines].reverse().find((l) => ERROR_LINE.test(l)) ?? lines[lines.length - 1];
}

/**
 * One short, single-line, path-free reason fit for `warnings[]`.
 *
 * A message that is already one line, path-free and short is returned
 * untouched — that is what keeps a deliberately crafted string intact, such as
 * `extractYtDlpError()`'s cookie hint (which names `YTDLP_COOKIES` and would be
 * useless truncated) or `audioExtractionReason()`'s "This video has no audio
 * track." Sanitizing on top of those would be the regression, not the fix.
 */
export function warningReason(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).trim();

  const alreadyClean =
    message.length <= MAX_LENGTH && !message.includes('\n') && !ABSOLUTE_PATH.test(message);
  // `test()` advances lastIndex on a /g regex; reset before the next use.
  ABSOLUTE_PATH.lastIndex = 0;
  if (alreadyClean) return message;

  const stderr = (error as { stderr?: unknown })?.stderr;
  const source = typeof stderr === 'string' && stderr.trim() ? stderr : message;
  const reason = (reasonLine(source) ?? reasonLine(message) ?? message.split(/\r?\n/)[0] ?? '')
    .replace(ABSOLUTE_PATH, '<path>')
    .replace(/\s+/g, ' ')
    .trim();

  return reason.length > MAX_LENGTH ? `${reason.slice(0, MAX_LENGTH - 1).trimEnd()}…` : reason;
}
