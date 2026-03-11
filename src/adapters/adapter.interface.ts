import { UserError } from 'fastmcp';
import type {
  IAdapterCapabilities,
  IChapter,
  ITranscriptEntry,
  IVideoComment,
  IVideoMetadata,
} from '../types.js';

export interface IVideoAdapter {
  readonly name: string;
  readonly capabilities: IAdapterCapabilities;

  canHandle(url: string): boolean;
  getMetadata(url: string): Promise<IVideoMetadata>;
  getTranscript(url: string): Promise<ITranscriptEntry[]>;
  getComments(url: string): Promise<IVideoComment[]>;
  getChapters(url: string): Promise<IChapter[]>;
  getAiSummary(url: string): Promise<string | null>;
  downloadVideo(url: string, destDir: string): Promise<string | null>;
}

const adapters: IVideoAdapter[] = [];

export function registerAdapter(adapter: IVideoAdapter): void {
  adapters.push(adapter);
}

export function getAdapter(url: string): IVideoAdapter {
  for (const adapter of adapters) {
    if (adapter.canHandle(url)) {
      return adapter;
    }
  }
  throw new UserError(
    `Unsupported video URL: "${url}". Supported platforms: Loom (loom.com/share/...), direct video files (.mp4, .webm, .mov).`,
  );
}

export function clearAdapters(): void {
  adapters.length = 0;
}
