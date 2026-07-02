export type DetailLevel = 'brief' | 'standard' | 'detailed';

interface DetailConfig {
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

/**
 * Effective frame budget: an explicit caller value always wins; otherwise the
 * standard level scales with duration, and other levels keep their fixed config
 * (brief=0; detailed=60 — dense 1fps sampling already self-scales under the cap).
 * Unknown duration (<=0) falls back to the fixed config value.
 */
export function resolveMaxFrames(
  explicit: number | undefined,
  level: DetailLevel,
  durationSeconds: number,
): number {
  if (explicit !== undefined) return explicit;
  if (level !== 'standard' || durationSeconds <= 0) return DETAIL_CONFIGS[level].maxFrames;
  if (durationSeconds <= 30) return 12;
  if (durationSeconds <= 60) return 20;
  if (durationSeconds <= 180) return 30;
  if (durationSeconds <= 600) return 45;
  return 60;
}
