export interface ITranscriptEntry {
  time: string;
  endTime?: string;
  speaker?: string;
  text: string;
}

export interface IVideoMetadata {
  platform: 'loom' | 'direct' | 'local' | 'unknown';
  title: string;
  description?: string;
  duration: number;
  durationFormatted: string;
  url: string;
  thumbnailUrl?: string;
  // Optional fields populated when the source is local and ffmpeg can probe
  // the file directly. Adapters that don't have this info leave them undefined.
  width?: number;
  height?: number;
  fps?: number;
  videoCodec?: string;
  audioCodec?: string;
  hasAudio?: boolean;
  creationTime?: string;
  fileSizeBytes?: number;
}

export interface IVideoComment {
  author: string;
  text: string;
  time?: string;
  createdAt?: string;
}

export interface IChapter {
  time: string;
  title: string;
}

export interface IFrameResult {
  time: string;
  filePath: string;
  mimeType: string;
}

export interface IOcrEntry {
  time: string;
  text: string;
  confidence: number;
}

export interface ITimelineEntry {
  time: string;
  seconds: number;
  transcript?: string;
  speaker?: string;
  frameIndex?: number;
  ocrText?: string;
}

export interface IAnalysisResult {
  metadata: IVideoMetadata;
  transcript: ITranscriptEntry[];
  frames: IFrameResult[];
  comments: IVideoComment[];
  chapters: IChapter[];
  ocrResults: IOcrEntry[];
  timeline: ITimelineEntry[];
  aiSummary?: string;
  warnings: string[];
}
export interface IAdapterCapabilities {
  transcript: boolean;
  metadata: boolean;
  comments: boolean;
  chapters: boolean;
  aiSummary: boolean;
  videoDownload: boolean;
}
