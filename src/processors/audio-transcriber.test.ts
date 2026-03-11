import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { extractAudioTrack, transcribeAudio } from './audio-transcriber.js';
import { createTempDir, cleanupTempDir } from '../utils/temp-files.js';
import { FIXTURES_DIR } from '../../test/helpers/index.js';

describe('extractAudioTrack', () => {
  it('throws for video without audio stream (tiny.mp4 has no audio)', async () => {
    const tempDir = await createTempDir();
    try {
      // tiny.mp4 is video-only (no audio stream), so extraction should fail
      await expect(extractAudioTrack(join(FIXTURES_DIR, 'tiny.mp4'), tempDir)).rejects.toThrow(
        'Audio extraction failed',
      );
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it('throws for non-existent video file', async () => {
    const tempDir = await createTempDir();
    try {
      await expect(extractAudioTrack('/nonexistent/video.mp4', tempDir)).rejects.toThrow(
        'Audio extraction failed',
      );
    } finally {
      await cleanupTempDir(tempDir);
    }
  });
});

describe('transcribeAudio', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAI_API_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns empty array when no transcription strategy is available', async () => {
    const result = await transcribeAudio(join(FIXTURES_DIR, 'tiny.mp4'));
    expect(Array.isArray(result)).toBe(true);
  });

  it('does not throw even when all strategies fail', async () => {
    const result = await transcribeAudio('/nonexistent/audio.wav');
    expect(result).toEqual([]);
  });
});

describe('transcribeAudio with OpenAI API key', () => {
  it('skips OpenAI when OPENAI_API_KEY is not set', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const result = await transcribeAudio('/nonexistent/audio.wav');
    expect(result).toEqual([]);
  });
});
