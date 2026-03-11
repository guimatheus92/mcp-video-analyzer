import type { IFrameResult, ITranscriptEntry } from '../types.js';
import type { IOcrResult } from './frame-ocr.js';

interface ITimelineEntry {
  time: string;
  seconds: number;
  transcript?: string;
  speaker?: string;
  frameIndex?: number;
  ocrText?: string;
}

/**
 * Build an annotated timeline that merges transcript entries, frame timestamps,
 * and OCR text into a single chronological view.
 *
 * This gives the AI a unified "what happened when" view:
 * - What was said (transcript)
 * - What changed visually (frames)
 * - What text was on screen (OCR)
 */
export function buildAnnotatedTimeline(
  transcript: ITranscriptEntry[],
  frames: IFrameResult[],
  ocrResults: IOcrResult[],
): ITimelineEntry[] {
  const entries: ITimelineEntry[] = [];

  // Add transcript entries
  for (const t of transcript) {
    entries.push({
      time: t.time,
      seconds: parseTimeToSeconds(t.time),
      transcript: t.text,
      speaker: t.speaker,
    });
  }

  // Add frame entries (merge with existing if timestamp matches)
  for (let i = 0; i < frames.length; i++) {
    const frameSeconds = parseTimeToSeconds(frames[i].time);
    const existing = findClosestEntry(entries, frameSeconds, 2);

    if (existing) {
      existing.frameIndex = i;
    } else {
      entries.push({
        time: frames[i].time,
        seconds: frameSeconds,
        frameIndex: i,
      });
    }
  }

  // Add OCR text (merge with existing if timestamp matches)
  for (const ocr of ocrResults) {
    const ocrSeconds = parseTimeToSeconds(ocr.time);
    const existing = findClosestEntry(entries, ocrSeconds, 2);

    if (existing) {
      existing.ocrText = ocr.text;
    } else {
      entries.push({
        time: ocr.time,
        seconds: ocrSeconds,
        ocrText: ocr.text,
      });
    }
  }

  // Sort chronologically
  entries.sort((a, b) => a.seconds - b.seconds);

  return entries;
}

/**
 * Find an existing entry within `toleranceSeconds` of the target time.
 */
function findClosestEntry(
  entries: ITimelineEntry[],
  targetSeconds: number,
  toleranceSeconds: number,
): ITimelineEntry | null {
  let closest: ITimelineEntry | null = null;
  let closestDiff = Infinity;

  for (const entry of entries) {
    const diff = Math.abs(entry.seconds - targetSeconds);
    if (diff <= toleranceSeconds && diff < closestDiff) {
      closest = entry;
      closestDiff = diff;
    }
  }

  return closest;
}

/**
 * Parse a timestamp string like "1:23" or "1:23:45" into seconds.
 */
export function parseTimeToSeconds(time: string): number {
  const parts = time.split(':').map(Number);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return 0;
}
