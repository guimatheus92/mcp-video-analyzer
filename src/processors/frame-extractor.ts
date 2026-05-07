import { execFile as execFileCb } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { IFrameResult } from '../types.js';

const execFile = promisify(execFileCb);

const require = createRequire(import.meta.url);
const ffmpegPath: string = require('ffmpeg-static') as string;

/** Normalize path to forward slashes for ffmpeg image2 muxer (Windows compat) */
function ffmpegPath_(p: string): string {
  return p.replace(/\\/g, '/');
}

export function parseTimestamp(ts: string): number {
  const parts = ts.split(':').map(Number);
  if (parts.some((p) => isNaN(p))) {
    throw new Error(`Invalid timestamp format: "${ts}"`);
  }

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  throw new Error(`Invalid timestamp format: "${ts}". Expected "M:SS" or "H:MM:SS".`);
}

export function formatTimestamp(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export async function probeVideoDuration(videoPath: string): Promise<number> {
  try {
    const { stderr } = await execFile(ffmpegPath, ['-i', videoPath, '-f', 'null', '-'], {
      timeout: 30000,
    });
    return parseDurationFromStderr(stderr);
  } catch (error: unknown) {
    // ffmpeg exits with code 1 even on successful probe; check stderr
    if (error && typeof error === 'object' && 'stderr' in error) {
      const stderr = (error as { stderr: string }).stderr;
      const duration = parseDurationFromStderr(stderr);
      if (duration > 0) return duration;
    }
    throw new Error(`Failed to probe video duration: ${videoPath}`, { cause: error });
  }
}

function parseDurationFromStderr(stderr: string): number {
  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
  if (!match) return 0;

  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = parseInt(match[3], 10);
  const centiseconds = parseInt(match[4], 10);

  return hours * 3600 + minutes * 60 + seconds + centiseconds / 100;
}

export interface IVideoProbeResult {
  duration: number;
  width?: number;
  height?: number;
  fps?: number;
  videoCodec?: string;
  hasAudio: boolean;
  audioCodec?: string;
  creationTime?: string;
}

/**
 * Probe a video file's metadata by parsing ffmpeg's stderr.
 *
 * `ffmpeg-static` doesn't ship `ffprobe`, so we invoke ffmpeg with no output
 * — it prints stream info to stderr and exits with code 1 ("At least one
 * output file must be specified"). This is the same trick `probeVideoDuration`
 * uses; we just parse more fields.
 */
export async function probeVideo(videoPath: string): Promise<IVideoProbeResult> {
  let stderr: string;
  try {
    ({ stderr } = await execFile(ffmpegPath, ['-i', videoPath], { timeout: 30000 }));
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'stderr' in error) {
      stderr = (error as { stderr: string }).stderr;
    } else {
      throw new Error(`Failed to probe video: ${videoPath}`, { cause: error });
    }
  }

  // ffmpeg only prints "Input #N, ..." when it successfully opens the file.
  // If that line is missing, the path was bad / format unrecognized — surface
  // the error rather than returning a half-empty result.
  if (!/^Input #\d+/m.test(stderr)) {
    throw new Error(`Failed to probe video: ${videoPath}`);
  }

  return parseProbeFromStderr(stderr);
}

function parseProbeFromStderr(stderr: string): IVideoProbeResult {
  const result: IVideoProbeResult = {
    duration: parseDurationFromStderr(stderr),
    hasAudio: false,
  };

  // Only parse the input section — ffmpeg may also print output streams.
  const inputSection = stderr.split(/^Output #\d+/m)[0];

  const videoMatch = inputSection.match(
    /Stream #\d+:\d+(?:[^:]*)?: Video: (\S+?)(?:\s|,)[^\n]*?(\d{2,5})x(\d{2,5})[^\n]*?(\d+(?:\.\d+)?) fps/,
  );
  if (videoMatch) {
    result.videoCodec = videoMatch[1].replace(/,$/, '');
    result.width = parseInt(videoMatch[2], 10);
    result.height = parseInt(videoMatch[3], 10);
    result.fps = parseFloat(videoMatch[4]);
  }

  const audioMatch = inputSection.match(/Stream #\d+:\d+(?:[^:]*)?: Audio: (\S+?)(?:\s|,)/);
  if (audioMatch) {
    result.hasAudio = true;
    result.audioCodec = audioMatch[1].replace(/,$/, '');
  }

  const creationMatch = inputSection.match(/creation_time\s*:\s*(\S+)/);
  if (creationMatch) {
    result.creationTime = creationMatch[1];
  }

  return result;
}

export function parseSceneTimestamps(stderr: string): number[] {
  const timestamps: number[] = [];
  const regex = /pts_time:(\d+(?:\.\d+)?)/g;
  let match;

  while ((match = regex.exec(stderr)) !== null) {
    timestamps.push(parseFloat(match[1]));
  }

  return timestamps;
}

export async function extractSceneFrames(
  videoPath: string,
  outputDir: string,
  options: { threshold?: number; maxFrames?: number } = {},
): Promise<IFrameResult[]> {
  const threshold = options.threshold ?? 0.1;
  const maxFrames = options.maxFrames ?? 20;

  const outputPattern = ffmpegPath_(join(outputDir, 'scene_%03d.jpg'));

  try {
    const { stderr } = await execFile(
      ffmpegPath,
      [
        '-i',
        videoPath,
        '-vf',
        `select='gt(scene,${threshold})',showinfo`,
        '-fps_mode',
        'vfr',
        '-q:v',
        '2',
        outputPattern,
        '-y',
      ],
      { timeout: 120000 },
    );

    const timestamps = parseSceneTimestamps(stderr);
    const files = await listFrameFiles(outputDir, 'scene_');

    const results: IFrameResult[] = files.slice(0, maxFrames).map((file, i) => ({
      time: formatTimestamp(timestamps[i] ?? 0),
      filePath: join(outputDir, file),
      mimeType: 'image/jpeg',
    }));

    return results;
  } catch (error: unknown) {
    // Try to parse results from partial output
    if (error && typeof error === 'object' && 'stderr' in error) {
      const stderr = (error as { stderr: string }).stderr;
      const timestamps = parseSceneTimestamps(stderr);
      const files = await listFrameFiles(outputDir, 'scene_').catch(() => [] as string[]);

      if (files.length > 0) {
        return files.slice(0, maxFrames).map((file, i) => ({
          time: formatTimestamp(timestamps[i] ?? 0),
          filePath: join(outputDir, file),
          mimeType: 'image/jpeg',
        }));
      }
    }

    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Scene frame extraction failed: ${msg}`, { cause: error });
  }
}

export async function extractFrameAt(
  videoPath: string,
  outputDir: string,
  timestamp: string,
): Promise<IFrameResult> {
  const seconds = parseTimestamp(timestamp);
  const outputPath = ffmpegPath_(join(outputDir, `frame_at_${seconds}.jpg`));

  try {
    await execFile(
      ffmpegPath,
      ['-ss', String(seconds), '-i', videoPath, '-frames:v', '1', '-q:v', '2', outputPath, '-y'],
      { timeout: 30000 },
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Frame extraction at ${timestamp} failed: ${msg}`, { cause: error });
  }

  return {
    time: timestamp,
    filePath: outputPath,
    mimeType: 'image/jpeg',
  };
}

export async function extractFrameBurst(
  videoPath: string,
  outputDir: string,
  from: string,
  to: string,
  count = 5,
): Promise<IFrameResult[]> {
  const fromSeconds = parseTimestamp(from);
  const toSeconds = parseTimestamp(to);

  if (toSeconds <= fromSeconds) {
    throw new Error(`"to" timestamp (${to}) must be after "from" timestamp (${from}).`);
  }

  const duration = toSeconds - fromSeconds;
  const fps = count / duration;

  const outputPattern = ffmpegPath_(join(outputDir, 'burst_%03d.jpg'));

  try {
    await execFile(
      ffmpegPath,
      [
        '-ss',
        String(fromSeconds),
        '-to',
        String(toSeconds),
        '-i',
        videoPath,
        '-vf',
        `fps=${fps}`,
        '-q:v',
        '2',
        outputPattern,
        '-y',
      ],
      { timeout: 60000 },
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Burst frame extraction failed: ${msg}`, { cause: error });
  }

  const files = await listFrameFiles(outputDir, 'burst_');

  return files.map((file, i) => {
    const frameTime = fromSeconds + (i * duration) / Math.max(count - 1, 1);
    return {
      time: formatTimestamp(Math.round(frameTime)),
      filePath: join(outputDir, file),
      mimeType: 'image/jpeg',
    };
  });
}

/**
 * Extract frames at a fixed rate (dense sampling).
 * Useful for "watching" the full video — captures 1 frame per second by default.
 */
export async function extractDenseFrames(
  videoPath: string,
  outputDir: string,
  options?: { fps?: number; maxFrames?: number },
): Promise<IFrameResult[]> {
  const requestedFps = options?.fps ?? 1;
  const maxFrames = options?.maxFrames ?? 60;

  // Probe duration to cap frame count
  const duration = await probeVideoDuration(videoPath);
  const expectedFrames = Math.ceil(duration * requestedFps);
  const effectiveFps = expectedFrames > maxFrames ? maxFrames / duration : requestedFps;

  const outputPattern = ffmpegPath_(join(outputDir, 'dense_%04d.jpg'));

  try {
    await execFile(
      ffmpegPath,
      ['-i', videoPath, '-vf', `fps=${effectiveFps}`, '-q:v', '2', outputPattern, '-y'],
      { timeout: 180000 },
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Dense frame extraction failed: ${msg}`, { cause: error });
  }

  const files = await listFrameFiles(outputDir, 'dense_');

  return files.slice(0, maxFrames).map((file, i) => ({
    time: formatTimestamp(Math.round(i / effectiveFps)),
    filePath: join(outputDir, file),
    mimeType: 'image/jpeg',
  }));
}

async function listFrameFiles(dir: string, prefix: string): Promise<string[]> {
  const files = await readdir(dir);
  return files.filter((f) => f.startsWith(prefix) && f.endsWith('.jpg')).sort();
}
