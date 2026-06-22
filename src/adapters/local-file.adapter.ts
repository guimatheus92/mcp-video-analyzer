import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { UserError } from 'fastmcp';
import { extractEmbeddedSubtitle } from '../processors/embedded-subtitles.js';
import { formatTimestamp, probeVideo } from '../processors/frame-extractor.js';
import type {
  IAdapterCapabilities,
  IChapter,
  ITranscriptEntry,
  IVideoComment,
  IVideoMetadata,
} from '../types.js';
import { findSidecarTranscript } from '../utils/sidecar-transcripts.js';
import { detectPlatform, toLocalPath } from '../utils/url-detector.js';
import type { IVideoAdapter } from './adapter.interface.js';

/**
 * Adapter for local video files. Accepts absolute fs paths and `file://` URIs.
 *
 * Local files are already on disk, so `downloadVideo` returns the resolved path
 * unchanged — frame extraction and audio transcoding then run via the same
 * ffmpeg pipeline used for downloaded videos.
 *
 * `getMetadata` runs a single short-lived ffmpeg probe (no transcode) to
 * populate duration, dimensions, fps, codecs, audio-track presence, and
 * container creation_time when available. It's far cheaper than Whisper and
 * lets callers skip the Whisper fallback for silent recordings.
 */
export class LocalFileAdapter implements IVideoAdapter {
  readonly name = 'local';
  readonly capabilities: IAdapterCapabilities = {
    // Sidecar `.vtt`/`.srt` files next to the video are picked up first, then
    // an embedded subtitle track; if neither exists this returns [] and the
    // tool-layer Whisper fallback handles it.
    transcript: true,
    metadata: true,
    comments: false,
    chapters: false,
    aiSummary: false,
    videoDownload: true,
  };

  canHandle(input: string): boolean {
    return detectPlatform(input) === 'local';
  }

  async getMetadata(input: string): Promise<IVideoMetadata> {
    const path = this.resolve(input);

    // A missing file is a hard error, not a silent zero-duration result —
    // throwing here lets the tool layer surface it via warnings[] (and keeps
    // those warning paths from being dead code). A present-but-unprobeable
    // file still degrades gracefully below.
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat?.isFile()) {
      throw new UserError(`Local video file not found: ${path}`);
    }
    const fileSizeBytes = stat.size;

    const probe = await probeVideo(path).catch(() => null);

    return {
      platform: 'local',
      title: basename(path),
      duration: probe?.duration ?? 0,
      durationFormatted: formatTimestamp(Math.floor(probe?.duration ?? 0)),
      url: input,
      width: probe?.width,
      height: probe?.height,
      fps: probe?.fps,
      videoCodec: probe?.videoCodec,
      audioCodec: probe?.audioCodec,
      hasAudio: probe?.hasAudio,
      creationTime: probe?.creationTime,
      fileSizeBytes,
    };
  }

  async getTranscript(input: string): Promise<ITranscriptEntry[]> {
    const path = this.resolve(input);

    // Sidecars first — if the user dropped a transcript next to the file
    // they likely want that one used over anything muxed in the container.
    const sidecar = await findSidecarTranscript(path);
    if (sidecar.length > 0) return sidecar;

    return extractEmbeddedSubtitle(path);
  }

  async getComments(_input: string): Promise<IVideoComment[]> {
    return [];
  }

  async getChapters(_input: string): Promise<IChapter[]> {
    return [];
  }

  async getAiSummary(_input: string): Promise<string | null> {
    return null;
  }

  async downloadVideo(input: string, _destDir: string): Promise<string | null> {
    const path = this.resolve(input);
    if (!existsSync(path)) {
      throw new UserError(`Local video file not found: ${path}`);
    }
    if (!statSync(path).isFile()) {
      throw new UserError(`Local video path is not a regular file: ${path}`);
    }
    return path;
  }

  private resolve(input: string): string {
    const path = toLocalPath(input);
    if (path === null) {
      throw new UserError(`Not a local video path: ${input}`);
    }
    return path;
  }
}
