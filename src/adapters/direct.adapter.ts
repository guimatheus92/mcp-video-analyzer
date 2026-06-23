import type {
  IAdapterCapabilities,
  IChapter,
  ITranscriptEntry,
  IVideoComment,
  IVideoMetadata,
} from '../types.js';
import { detectPlatform } from '../utils/url-detector.js';
import { downloadDirectVideo, getFilenameFromUrl } from '../utils/video-download.js';
import type { IVideoAdapter } from './adapter.interface.js';

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
    return downloadDirectVideo(url, destDir);
  }
}
