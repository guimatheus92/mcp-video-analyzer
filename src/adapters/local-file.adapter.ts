import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { UserError } from 'fastmcp';
import type {
  IAdapterCapabilities,
  IChapter,
  ITranscriptEntry,
  IVideoComment,
  IVideoMetadata,
} from '../types.js';
import { detectPlatform, toLocalPath } from '../utils/url-detector.js';
import type { IVideoAdapter } from './adapter.interface.js';

/**
 * Adapter for local video files. Accepts absolute fs paths and `file://` URIs.
 *
 * Local files are already on disk, so `downloadVideo` returns the resolved path
 * unchanged — frame extraction and audio transcoding then run via the same
 * ffmpeg pipeline used for downloaded videos.
 *
 * Duration probing via ffprobe could be added here, but the existing tools
 * already fall back to `probeVideoDuration(videoPath)` when metadata reports 0,
 * which gives the same result for free.
 */
export class LocalFileAdapter implements IVideoAdapter {
  readonly name = 'local';
  readonly capabilities: IAdapterCapabilities = {
    transcript: false,
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
    return {
      platform: 'local',
      title: basename(path),
      duration: 0,
      durationFormatted: '0:00',
      url: input,
    };
  }

  async getTranscript(_input: string): Promise<ITranscriptEntry[]> {
    return [];
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
