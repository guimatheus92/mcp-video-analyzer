export type DetailLevel = 'brief' | 'standard' | 'detailed';

export interface DetailConfig {
  /** Maximum frames to extract (0 = skip frames entirely) */
  maxFrames: number;
  /** Maximum transcript entries to return (null = unlimited) */
  transcriptMaxEntries: number | null;
  /** Whether to run OCR on extracted frames */
  includeOcr: boolean;
  /** Whether to build the annotated timeline */
  includeTimeline: boolean;
  /** Whether to extract frames at all */
  includeFrames: boolean;
  /** Whether to use dense sampling (1 fps) instead of scene detection */
  denseSampling: boolean;
}

export const DETAIL_CONFIGS: Record<DetailLevel, DetailConfig> = {
  brief: {
    maxFrames: 0,
    transcriptMaxEntries: 10,
    includeOcr: false,
    includeTimeline: false,
    includeFrames: false,
    denseSampling: false,
  },
  standard: {
    maxFrames: 20,
    transcriptMaxEntries: null,
    includeOcr: true,
    includeTimeline: true,
    includeFrames: true,
    denseSampling: false,
  },
  detailed: {
    maxFrames: 60,
    transcriptMaxEntries: null,
    includeOcr: true,
    includeTimeline: true,
    includeFrames: true,
    denseSampling: true,
  },
};

export function getDetailConfig(level: DetailLevel): DetailConfig {
  return DETAIL_CONFIGS[level];
}
