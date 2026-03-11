import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
  IAdapterCapabilities,
  IChapter,
  ITranscriptEntry,
  IVideoComment,
  IVideoMetadata,
} from '../types.js';
import { detectPlatform } from '../utils/url-detector.js';
import type { IVideoAdapter } from './adapter.interface.js';

function getFilenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/');
    const lastSegment = segments[segments.length - 1];
    if (lastSegment && lastSegment.includes('.')) {
      return lastSegment;
    }
  } catch {
    // ignore parse errors
  }
  return 'video.mp4';
}

export class DirectAdapter implements IVideoAdapter {
  readonly name = 'direct';
  readonly capabilities: IAdapterCapabilities = {
    transcript: false,
    metadata: false,
    comments: false,
    chapters: false,
    aiSummary: false,
    videoDownload: true,
  };

  canHandle(url: string): boolean {
    return detectPlatform(url) === 'direct';
  }

  async getMetadata(url: string): Promise<IVideoMetadata> {
    const filename = getFilenameFromUrl(url);
    return {
      platform: 'direct',
      title: filename,
      duration: 0,
      durationFormatted: '0:00',
      url,
    };
  }

  async getTranscript(_url: string): Promise<ITranscriptEntry[]> {
    return [];
  }

  async getComments(_url: string): Promise<IVideoComment[]> {
    return [];
  }

  async getChapters(_url: string): Promise<IChapter[]> {
    return [];
  }

  async getAiSummary(_url: string): Promise<string | null> {
    return null;
  }

  async downloadVideo(url: string, destDir: string): Promise<string | null> {
    const filename = getFilenameFromUrl(url);
    const destPath = join(destDir, filename);

    const response = await fetch(url);
    if (!response.ok || !response.body) {
      return null;
    }

    const nodeStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    await pipeline(nodeStream, createWriteStream(destPath));

    return destPath;
  }
}
