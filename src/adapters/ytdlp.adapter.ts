import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { formatTimestamp } from '../processors/frame-extractor.js';
import type {
  IAdapterCapabilities,
  IChapter,
  ITranscriptEntry,
  IVideoComment,
  IVideoMetadata,
} from '../types.js';
import { cleanupTempDir, createTempDir } from '../utils/temp-files.js';
import { detectPlatform } from '../utils/url-detector.js';
import { parseVtt } from '../utils/vtt-parser.js';
import { findYtDlp, runYtDlp, ytdlpCookieArgs } from '../utils/ytdlp.js';
import type { IVideoAdapter } from './adapter.interface.js';

const require = createRequire(import.meta.url);
const ffmpegPath: string = require('ffmpeg-static') as string;

const YTDLP_MISSING =
  'yt-dlp is not installed — install it ("pip install yt-dlp" or https://github.com/yt-dlp/yt-dlp#installation) to analyze YouTube/Vimeo/TikTok/Instagram/X/Twitch/Dailymotion/Facebook URLs.';

/**
 * Download-only variant. LoomAdapter delegates its download here, and Loom is
 * not in the platform list above — a Loom user would otherwise get a hint
 * naming every platform except the one they used. Kept separate from
 * YTDLP_MISSING so `getTranscript`/`getMetadata` on a YouTube URL don't
 * mention Loom.
 */
const YTDLP_MISSING_FOR_DOWNLOAD = `${YTDLP_MISSING} It is also what fetches and merges Loom's separate video+audio streams for frame extraction.`;

/** YouTube -J payloads routinely exceed execFile's 1MB default buffer. */
const INFO_MAX_BUFFER = 64 * 1024 * 1024;

interface YtDlpInfo {
  title?: string;
  description?: string;
  duration?: number;
  uploader?: string;
  channel?: string;
  upload_date?: string;
  view_count?: number;
  thumbnail?: string;
  width?: number;
  height?: number;
  fps?: number;
  chapters?: { start_time: number; title: string }[] | null;
}

/**
 * Flags every yt-dlp invocation needs. `cookies` is a parameter only so the
 * download retry can drop them — keeping ONE definition, so a flag added here
 * later can't silently skip the download path (that divergence-by-copy is
 * exactly how issue #24 happened, one level up).
 */
function commonArgs(cookies: string[] = ytdlpCookieArgs()): string[] {
  return ['--no-warnings', '--no-playlist', ...cookies];
}

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

/**
 * Pull the first `ERROR: ...` line out of yt-dlp's stderr so private /
 * age-restricted / unavailable videos surface as readable warnings. When the
 * failure looks auth-related (common for Instagram/private posts), append a
 * hint pointing at the env vars THIS server reads — yt-dlp's own message only
 * mentions raw `--cookies` CLI flags the MCP user never invokes.
 */
function extractYtDlpError(err: unknown): string {
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
 * Collapse the rolling-window duplication of YouTube auto-captions, where each
 * cue repeats the tail of the previous one: trims the longest overlap between
 * the end of the previous cue and the start of the current one.
 */
// ponytail: naive overlap trim; switch to yt-dlp's json3 sub format if quality matters.
export function collapseRollingCaptions(entries: ITranscriptEntry[]): ITranscriptEntry[] {
  const out: ITranscriptEntry[] = [];
  let prevText = '';

  for (const entry of entries) {
    const text = entry.text.trim();
    if (!text) continue;

    let overlap = 0;
    for (let n = Math.min(prevText.length, text.length); n > 0; n--) {
      // Whole-word overlaps only: the cut must land on a word boundary in both
      // cues, else "…same liNE" × "NExt line…" would falsely trim mid-word.
      if (n < text.length && text[n] !== ' ') continue;
      const cutStart = prevText.length - n;
      if (cutStart > 0 && prevText[cutStart - 1] !== ' ') continue;
      if (prevText.endsWith(text.slice(0, n))) {
        overlap = n;
        break;
      }
    }
    prevText = text;

    const remainder = text.slice(overlap).trim();
    if (!remainder) continue;
    out.push({ ...entry, text: remainder });
  }

  return out;
}

export class YtDlpAdapter implements IVideoAdapter {
  readonly name = 'ytdlp';
  readonly capabilities: IAdapterCapabilities = {
    transcript: true,
    metadata: true,
    comments: false,
    chapters: true,
    aiSummary: false,
    videoDownload: true,
  };

  canHandle(url: string): boolean {
    return detectPlatform(url) === 'ytdlp';
  }

  async getMetadata(url: string): Promise<IVideoMetadata> {
    const info = await this.fetchInfo(url);
    const duration = info.duration ?? 0;

    return {
      platform: 'ytdlp',
      title: info.title ?? 'Untitled',
      description: info.description || undefined,
      duration,
      durationFormatted: formatTimestamp(Math.floor(duration)),
      url,
      thumbnailUrl: info.thumbnail,
      width: info.width,
      height: info.height,
      fps: info.fps,
      uploader: info.uploader ?? info.channel,
      viewCount: info.view_count,
      creationTime: formatUploadDate(info.upload_date),
    };
  }

  /**
   * Native captions via yt-dlp: uploaded subtitles first, auto-generated as a
   * fallback (with rolling-window collapse). Returns [] only when yt-dlp exited
   * cleanly and produced no subtitle files (the video has no captions) — the
   * pipeline then downloads the video and runs Whisper. A failed fetch throws,
   * so callers surface it as a "Failed to fetch transcript" warning instead of
   * mislabeling the video as captionless.
   */
  async getTranscript(url: string): Promise<ITranscriptEntry[]> {
    const ytDlp = await findYtDlp();
    if (!ytDlp) throw new Error(YTDLP_MISSING);

    const dir = await createTempDir('mcp-ytdlp-subs-');
    try {
      const lang = process.env.WHISPER_LANGUAGE?.trim() || undefined;
      const subLangs = lang ? `${lang}.*,en.*` : 'en.*';
      const baseArgs = [
        '--skip-download',
        '--write-subs',
        '--sub-format',
        'vtt',
        '--sub-langs',
        subLangs,
        '-o',
        join(dir, 'subs'),
        ...commonArgs(),
        url,
      ];

      // Pass 1: uploaded subtitles only (clean cues, no collapse needed).
      // A rejection here is swallowed because pass 2 retries --write-subs too.
      await runYtDlp(ytDlp, baseArgs, { timeout: 60000 }).catch(() => undefined);
      let vtt = await readBestSubtitle(dir, lang);
      if (vtt) return parseVtt(vtt);

      // Pass 2: auto-generated captions (retries uploaded subs as well).
      const autoArgs = [...baseArgs];
      autoArgs.splice(autoArgs.indexOf('--write-subs') + 1, 0, '--write-auto-subs');
      let pass2Error: unknown;
      await runYtDlp(ytDlp, autoArgs, { timeout: 60000 }).catch((e: unknown) => {
        pass2Error = e;
      });
      vtt = await readBestSubtitle(dir, lang);
      if (vtt) return collapseRollingCaptions(parseVtt(vtt));

      if (pass2Error) {
        throw new Error(extractYtDlpError(pass2Error), { cause: pass2Error });
      }
      return [];
    } finally {
      await cleanupTempDir(dir).catch(() => undefined);
    }
  }

  async getComments(_url: string): Promise<IVideoComment[]> {
    return [];
  }

  async getChapters(url: string): Promise<IChapter[]> {
    // Shares the in-flight -J with getMetadata (pipeline's Promise.all).
    // Quiet catch — the metadata leg already carries the warning.
    try {
      const info = await this.fetchInfo(url);
      return (info.chapters ?? [])
        .filter((c) => Number.isFinite(c?.start_time))
        .map((c) => ({
          time: formatTimestamp(Math.floor(c.start_time)),
          title: c.title,
        }));
    } catch {
      return [];
    }
  }

  async getAiSummary(_url: string): Promise<string | null> {
    return null;
  }

  /** Never rejects — the pipeline calls this without a catch (Loom precedent). */
  async downloadVideo(
    url: string,
    destDir: string,
    onWarning?: (message: string) => void,
    /**
     * Beyond IVideoAdapter, for callers that have a working fallback and
     * shouldn't wait the full budget before trying it — LoomAdapter passes the
     * 120s it used before delegating here, so a stalled yt-dlp reaches Loom's
     * CDN strategy as quickly as it used to.
     */
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
      // NEVER hardcode an extension here: on a DASH merge yt-dlp appends the
      // real container to the template, so `-o x.mp4` yields `x.mp4.webm`.
      // %(ext)s + pickDownloadedFile keeps the two in sync (issue #24).
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
      // wall-clock (two 300s timeouts) and, for a genuinely private video,
      // would replace the real error with a credential-less "login required"
      // that tells the user to configure cookies they already configured.
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

    return this.pickDownloadedFile(destDir, onWarning);
  }

  /**
   * Picks yt-dlp's merged output out of `destDir`.
   *
   * Deliberately stricter than `startsWith('video.')`. yt-dlp names per-format
   * streams `video.f<id>.<ext>` and in-progress files `.part`/`.ytdl`, and when
   * a merge does not happen it leaves them behind — the reporter's environment
   * had `video.fdash-raw-0.webm` (audio) next to `video.fdash-raw-original.webm`
   * (video). A loose glob would return whichever `readdir` listed first,
   * plausibly the audio-only stream: zero frames again, for a new reason.
   */
  private async pickDownloadedFile(
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

    // Merged output may be .mp4/.webm/.mkv depending on the source formats,
    // but it never carries a per-format `.f<id>` infix.
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

  // In-flight -J memo: getMetadata and getChapters run concurrently in the
  // pipeline's Promise.all — share one yt-dlp process per URL. Deleted on
  // settle, so forceRefresh and later calls still re-fetch.
  private readonly infoInFlight = new Map<string, Promise<YtDlpInfo>>();

  private fetchInfo(url: string): Promise<YtDlpInfo> {
    const existing = this.infoInFlight.get(url);
    if (existing) return existing;
    const info = this.doFetchInfo(url).finally(() => this.infoInFlight.delete(url));
    this.infoInFlight.set(url, info);
    return info;
  }

  private async doFetchInfo(url: string): Promise<YtDlpInfo> {
    const ytDlp = await findYtDlp();
    if (!ytDlp) throw new Error(YTDLP_MISSING);

    try {
      const { stdout } = await runYtDlp(ytDlp, ['-J', ...commonArgs(), url], {
        timeout: 30000,
        maxBuffer: INFO_MAX_BUFFER,
      });
      return JSON.parse(stdout) as YtDlpInfo;
    } catch (err: unknown) {
      throw new Error(extractYtDlpError(err), { cause: err });
    }
  }
}

/** yt-dlp reports upload_date as YYYYMMDD. */
function formatUploadDate(raw: string | undefined): string | undefined {
  if (!raw || !/^\d{8}$/.test(raw)) return undefined;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

async function readBestSubtitle(dir: string, lang: string | undefined): Promise<string | null> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.vtt')).sort();
  } catch {
    return null;
  }
  if (files.length === 0) return null;

  const best =
    (lang ? files.find((f) => f.includes(`.${lang}`)) : undefined) ??
    files.find((f) => f.includes('.en')) ??
    files[0];

  try {
    return await readFile(join(dir, best), 'utf-8');
  } catch {
    return null;
  }
}
