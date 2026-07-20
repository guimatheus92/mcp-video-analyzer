import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES_DIR } from '../../test/helpers/index.js';
import { cleanupTempDir, createTempDir } from '../utils/temp-files.js';
import {
  extractDenseFrames,
  extractFrameAt,
  extractKeyFrames,
  formatTimestamp,
  parseProbeFromStderr,
  parseSceneTimestamps,
  parseTimestamp,
  probeVideo,
  probeVideoDuration,
} from './frame-extractor.js';

describe('parseTimestamp', () => {
  it('parses "1:23" to 83 seconds', () => {
    expect(parseTimestamp('1:23')).toBe(83);
  });

  it('parses "0:05" to 5 seconds', () => {
    expect(parseTimestamp('0:05')).toBe(5);
  });

  it('parses "01:23:45" to 5025 seconds', () => {
    expect(parseTimestamp('01:23:45')).toBe(5025);
  });

  it('parses "0:00" to 0 seconds', () => {
    expect(parseTimestamp('0:00')).toBe(0);
  });

  it('parses "10:30" to 630 seconds', () => {
    expect(parseTimestamp('10:30')).toBe(630);
  });

  it('throws for invalid format', () => {
    expect(() => parseTimestamp('abc')).toThrow('Invalid timestamp');
  });

  it('throws for single number', () => {
    expect(() => parseTimestamp('5')).toThrow('Invalid timestamp');
  });
});

describe('formatTimestamp', () => {
  it('formats 83 seconds as "1:23"', () => {
    expect(formatTimestamp(83)).toBe('1:23');
  });

  it('formats 5 seconds as "0:05"', () => {
    expect(formatTimestamp(5)).toBe('0:05');
  });

  it('formats 5025 seconds as "1:23:45"', () => {
    expect(formatTimestamp(5025)).toBe('1:23:45');
  });

  it('formats 0 seconds as "0:00"', () => {
    expect(formatTimestamp(0)).toBe('0:00');
  });

  it('formats 3600 seconds as "1:00:00"', () => {
    expect(formatTimestamp(3600)).toBe('1:00:00');
  });
});

describe('parseSceneTimestamps', () => {
  it('extracts pts_time values from ffmpeg stderr', () => {
    const stderr = readFileSync(join(FIXTURES_DIR, 'ffmpeg-scene-stderr.txt'), 'utf-8');
    const timestamps = parseSceneTimestamps(stderr);

    expect(timestamps).toEqual([0, 5, 12.5, 30]);
  });

  it('returns empty array for no matches', () => {
    expect(parseSceneTimestamps('no timestamps here')).toEqual([]);
  });
});

describe('probeVideoDuration', () => {
  it('returns duration of tiny.mp4 fixture (~3 seconds)', async () => {
    const duration = await probeVideoDuration(join(FIXTURES_DIR, 'tiny.mp4'));
    expect(duration).toBeGreaterThan(2);
    expect(duration).toBeLessThan(4);
  });

  it('throws for non-existent file', async () => {
    await expect(probeVideoDuration('/nonexistent/video.mp4')).rejects.toThrow();
  });
});

describe('probeVideo', () => {
  it('returns full metadata for tiny.mp4 fixture', async () => {
    const probe = await probeVideo(join(FIXTURES_DIR, 'tiny.mp4'));

    expect(probe.duration).toBeGreaterThan(2);
    expect(probe.duration).toBeLessThan(4);
    expect(probe.width).toBe(320);
    expect(probe.height).toBe(240);
    expect(probe.fps).toBe(10);
    expect(probe.videoCodec).toBe('h264');
  });

  it('reports hasAudio=false for tiny.mp4 (no audio track)', async () => {
    const probe = await probeVideo(join(FIXTURES_DIR, 'tiny.mp4'));
    expect(probe.hasAudio).toBe(false);
    expect(probe.audioCodec).toBeUndefined();
  });

  it('throws for non-existent file', async () => {
    await expect(probeVideo('/nonexistent/video.mp4')).rejects.toThrow();
  });
});

// A DASH Loom merges to vp9/opus in a webm container, not mp4 (issue #24).
// Returning the right filename is only half the fix — the bundled ffmpeg has
// to actually decode it. Deterministic and offline, unlike the Loom e2e.
describe('vp9/webm source (issue #24 merge output)', () => {
  const tinyWebm = join(FIXTURES_DIR, 'tiny.webm');

  it('probes a vp9/opus webm', async () => {
    const probe = await probeVideo(tinyWebm);

    expect(probe.videoCodec).toBe('vp9');
    expect(probe.hasAudio).toBe(true);
    expect(probe.audioCodec).toBe('opus');
    expect(probe.duration).toBeGreaterThan(1);
  });

  it('extracts JPEG frames from a vp9/opus webm', async () => {
    const tempDir = await createTempDir();
    try {
      const { frames } = await extractKeyFrames(tinyWebm, tempDir, { maxFrames: 3 });

      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(existsSync(frame.filePath)).toBe(true);
        expect(frame.mimeType).toBe('image/jpeg');
      }
    } finally {
      await cleanupTempDir(tempDir);
    }
  });
});

describe('parseProbeFromStderr', () => {
  it('parses a stream with audio and creation_time', () => {
    const stderr = [
      "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'sample.mp4':",
      '  Metadata:',
      '    creation_time   : 2024-01-15T10:30:00.000000Z',
      '  Duration: 00:01:23.45, start: 0.000000, bitrate: 1234 kb/s',
      '  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080, 5000 kb/s, 30 fps, 30 tbr, 15360 tbn (default)',
      '  Stream #0:1[0x2](eng): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s (default)',
    ].join('\n');

    const probe = parseProbeFromStderr(stderr);

    expect(probe.duration).toBeCloseTo(83.45, 1);
    expect(probe.width).toBe(1920);
    expect(probe.height).toBe(1080);
    expect(probe.fps).toBe(30);
    expect(probe.videoCodec).toBe('h264');
    expect(probe.hasAudio).toBe(true);
    expect(probe.audioCodec).toBe('aac');
    expect(probe.creationTime).toBe('2024-01-15T10:30:00.000000Z');
  });

  it('parses resolution/codec even when ffmpeg omits fps (VFR / tbr-only stream)', () => {
    const stderr = [
      "Input #0, matroska,webm, from 'novfr.mkv':",
      '  Duration: 00:00:10.00, start: 0.000000, bitrate: 800 kb/s',
      '  Stream #0:0: Video: vp9 (Profile 0), yuv420p(tv), 1280x720, SAR 1:1 DAR 16:9, 25 tbr, 1k tbn (default)',
    ].join('\n');

    const probe = parseProbeFromStderr(stderr);

    expect(probe.width).toBe(1280);
    expect(probe.height).toBe(720);
    expect(probe.videoCodec).toBe('vp9');
    expect(probe.fps).toBeUndefined();
    expect(probe.hasAudio).toBe(false);
  });

  it('returns zeroed/empty result for unparseable stderr', () => {
    const probe = parseProbeFromStderr('garbage with no recognizable streams');
    expect(probe.duration).toBe(0);
    expect(probe.hasAudio).toBe(false);
    expect(probe.width).toBeUndefined();
  });
});

describe('extractFrameAt', () => {
  it('extracts a single frame from tiny.mp4', async () => {
    const tempDir = await createTempDir();
    try {
      const result = await extractFrameAt(join(FIXTURES_DIR, 'tiny.mp4'), tempDir, '0:01');

      expect(result.time).toBe('0:01');
      expect(result.mimeType).toBe('image/jpeg');
      expect(existsSync(result.filePath)).toBe(true);
    } finally {
      await cleanupTempDir(tempDir);
    }
  });
});

describe('extractDenseFrames', () => {
  it('extracts frames from tiny.mp4 at 1 fps', async () => {
    const tempDir = await createTempDir();
    try {
      const frames = await extractDenseFrames(join(FIXTURES_DIR, 'tiny.mp4'), tempDir, {
        fps: 1,
        maxFrames: 10,
      });

      // tiny.mp4 is ~3 seconds, so expect ~3 frames at 1fps
      expect(frames.length).toBeGreaterThanOrEqual(2);
      expect(frames.length).toBeLessThanOrEqual(4);
      expect(frames[0].mimeType).toBe('image/jpeg');
      expect(frames[0].time).toBe('0:00');

      for (const frame of frames) {
        expect(existsSync(frame.filePath)).toBe(true);
      }
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it('caps frames at maxFrames', async () => {
    const tempDir = await createTempDir();
    try {
      const frames = await extractDenseFrames(join(FIXTURES_DIR, 'tiny.mp4'), tempDir, {
        fps: 10, // Would produce ~30 frames for 3s video
        maxFrames: 5,
      });

      expect(frames.length).toBeLessThanOrEqual(5);
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it('throws for non-existent video', async () => {
    const tempDir = await createTempDir();
    try {
      await expect(extractDenseFrames('/nonexistent/video.mp4', tempDir)).rejects.toThrow();
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it('produces frames with correct timestamp format', async () => {
    const tempDir = await createTempDir();
    try {
      const frames = await extractDenseFrames(join(FIXTURES_DIR, 'tiny.mp4'), tempDir, {
        fps: 1,
        maxFrames: 10,
      });

      for (const frame of frames) {
        expect(frame.time).toMatch(/^\d+:\d{2}$/);
      }
    } finally {
      await cleanupTempDir(tempDir);
    }
  });
});

describe('extractKeyFrames', () => {
  it('returns frames in dense mode (uniform sampling)', async () => {
    const tempDir = await createTempDir();
    try {
      const { frames, warnings } = await extractKeyFrames(join(FIXTURES_DIR, 'tiny.mp4'), tempDir, {
        dense: true,
        maxFrames: 10,
      });

      expect(frames.length).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(warnings)).toBe(true);
      for (const frame of frames) {
        expect(existsSync(frame.filePath)).toBe(true);
      }
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it('yields frames for a clip even with no scene cuts (falls back to uniform sampling)', async () => {
    const tempDir = await createTempDir();
    try {
      // ffmpeg scene scores are in [0,1], so gt(scene,1) is never true →
      // scene detection finds nothing and the uniform-sampling fallback kicks in.
      const { frames, warnings } = await extractKeyFrames(join(FIXTURES_DIR, 'tiny.mp4'), tempDir, {
        threshold: 1.0,
        maxFrames: 10,
      });

      expect(frames.length).toBeGreaterThanOrEqual(1);
      expect(warnings.some((w) => w.includes('uniform temporal sampling'))).toBe(true);
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it('degrades to an empty result with a warning (never throws) for a bad file', async () => {
    const tempDir = await createTempDir();
    try {
      const { frames, warnings } = await extractKeyFrames('/nonexistent/video.mp4', tempDir, {
        maxFrames: 5,
      });

      expect(frames).toEqual([]);
      expect(warnings.length).toBeGreaterThan(0);
    } finally {
      await cleanupTempDir(tempDir);
    }
  });
});
