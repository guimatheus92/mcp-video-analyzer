export interface ITranscriptEntry {
  time: string;
  endTime?: string;
  speaker?: string;
  text: string;
}

export interface IVideoMetadata {
  platform: 'loom' | 'direct' | 'twelvelabs' | 'unknown';
  title: string;
  description?: string;
  duration: number;
  durationFormatted: string;
  url: string;
  thumbnailUrl?: string;
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
