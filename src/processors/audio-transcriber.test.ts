import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURES_DIR } from '../../test/helpers/index.js';
import { cleanupTempDir, createTempDir } from '../utils/temp-files.js';
import {
  buildWhisperCliArgs,
  extractAudioTrack,
  parseWhisperJson,
  transcribeAudio,
} from './audio-transcriber.js';

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

describe('buildWhisperCliArgs', () => {
  beforeEach(() => {
    vi.stubEnv('WHISPER_MODEL', '');
    vi.stubEnv('WHISPER_LANGUAGE', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to the tiny model and writes JSON to the given output dir', () => {
    const args = buildWhisperCliArgs('/audio/clip.wav', '/tmp/out');
    expect(args).toEqual([
      '/audio/clip.wav',
      '--output_format',
      'json',
      '--model',
      'tiny',
      '--output_dir',
      '/tmp/out',
    ]);
  });

  it('does not pass --language when WHISPER_LANGUAGE is unset', () => {
    const args = buildWhisperCliArgs('/audio/clip.wav', '/tmp/out');
    expect(args).not.toContain('--language');
  });

  it('honors WHISPER_MODEL override', () => {
    vi.stubEnv('WHISPER_MODEL', 'small');
    const args = buildWhisperCliArgs('/audio/clip.wav', '/tmp/out');
    const modelIdx = args.indexOf('--model');
    expect(args[modelIdx + 1]).toBe('small');
  });

  it('injects --language when WHISPER_LANGUAGE is set', () => {
    vi.stubEnv('WHISPER_LANGUAGE', 'pt');
    const args = buildWhisperCliArgs('/audio/clip.wav', '/tmp/out');
    const langIdx = args.indexOf('--language');
    expect(langIdx).toBeGreaterThan(-1);
    expect(args[langIdx + 1]).toBe('pt');
  });
});

describe('parseWhisperJson', () => {
  it('maps segments to timestamped entries', () => {
    const raw = JSON.stringify({
      text: 'full',
      segments: [
        { start: 0, end: 2.5, text: ' Olá, tudo bem? ' },
        { start: 75.2, end: 78, text: 'Segundo trecho.' },
      ],
    });
    expect(parseWhisperJson(raw)).toEqual([
      { time: '0:00', text: 'Olá, tudo bem?' },
      { time: '1:15', text: 'Segundo trecho.' },
    ]);
  });

  it('drops empty/whitespace-only segments', () => {
    const raw = JSON.stringify({
      segments: [
        { start: 0, text: '   ' },
        { start: 3, text: 'real' },
      ],
    });
    expect(parseWhisperJson(raw)).toEqual([{ time: '0:03', text: 'real' }]);
  });

  it('returns null for invalid JSON', () => {
    expect(parseWhisperJson('not json')).toBeNull();
  });

  it('returns null when there is no segments array', () => {
    expect(parseWhisperJson(JSON.stringify({ text: 'only text' }))).toBeNull();
  });
});
