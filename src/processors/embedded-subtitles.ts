import { execFile as execFileCb } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import type { ITranscriptEntry } from '../types.js';
import { parseVtt } from '../utils/vtt-parser.js';

const execFile = promisify(execFileCb);

const require = createRequire(import.meta.url);
const ffmpegPath: string = require('ffmpeg-static') as string;

/**
 * Extract the first embedded subtitle stream from a container as a transcript.
 *
 * Many recording tools (OBS, ScreenFlow, Riverside) ship caption tracks
 * inside the video container. ffmpeg can transmux them to WebVTT directly
 * — orders of magnitude cheaper than Whisper.
 *
 * `-map 0:s:0?` makes the subtitle mapping optional: when no subtitle
 * stream exists, ffmpeg produces an empty/header-only VTT that the parser
 * resolves to []. Errors from ffmpeg are non-fatal and degrade to [].
 */
export async function extractEmbeddedSubtitle(videoPath: string): Promise<ITranscriptEntry[]> {
  try {
    const { stdout } = await execFile(
      ffmpegPath,
      ['-loglevel', 'error', '-i', videoPath, '-map', '0:s:0?', '-f', 'webvtt', '-'],
      { timeout: 30000, maxBuffer: 50 * 1024 * 1024 },
    );
    return parseVtt(normalizeVttTimestamps(stdout));
  } catch {
    return [];
  }
}

/**
 * ffmpeg's webvtt muxer emits short-form `MM:SS.mmm` cues for sub-1-hour
 * videos, but the VTT parser only matches the long form `HH:MM:SS.mmm`.
 * Normalize so both spec-valid forms reach the parser.
 */
function normalizeVttTimestamps(vtt: string): string {
  return vtt.replace(
    /(?<![\d:])(\d{2}):(\d{2}\.\d{3})\s*-->\s*(\d{2}):(\d{2}\.\d{3})/g,
    '00:$1:$2 --> 00:$3:$4',
  );
}
