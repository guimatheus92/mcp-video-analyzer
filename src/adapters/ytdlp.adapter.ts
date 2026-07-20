import { readFile, readdir } from 'node:fs/promises';
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
import {
  YTDLP_MISSING,
  commonArgs,
  downloadViaYtDlp,
  extractYtDlpError,
  findYtDlp,
  runYtDlp,
} from '../utils/ytdlp.js';
import type { IVideoAdapter } from './adapter.interface.js';

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
    timeout?: number,
  ): Promise<string | null> {
    return downloadViaYtDlp(url, destDir, onWarning, timeout);
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
