import { execFile as execFileCb } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURES_DIR } from '../../test/helpers/index.js';
import { cleanupTempDir, createTempDir } from '../utils/temp-files.js';
import {
  buildWhisperCliArgs,
  extractAudioTrack,
  parseMeanVolume,
  parseWhisperJson,
  transcribeAudio,
} from './audio-transcriber.js';

const execFile = promisify(execFileCb);
const ffmpegPath: string = createRequire(import.meta.url)('ffmpeg-static') as string;

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
    // Make "no strategy available" true on every machine: without these stubs
    // the tests silently exercise whatever whisper/HF/OpenAI the host has
    // installed (slow and environment-dependent).
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('WHISPER_HF_MODEL', '');
    vi.stubEnv('WHISPER_BIN', '');
    vi.stubEnv('PATH', '');
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

  it('skips every strategy for a silent track, with a warning', async () => {
    const tempDir = await createTempDir();
    try {
      const silentWav = join(tempDir, 'silent.wav');
      await execFile(
        ffmpegPath,
        ['-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1', silentWav, '-y'],
        { timeout: 30000 },
      );

      const warnings: string[] = [];
      const result = await transcribeAudio(silentWav, {}, (w) => warnings.push(w));

      expect(result).toEqual([]);
      expect(warnings.some((w) => w.includes('silent'))).toBe(true);
    } finally {
      await cleanupTempDir(tempDir);
    }
  });
});

describe('parseMeanVolume', () => {
  it('reads the mean volume from volumedetect stderr', () => {
    const stderr = [
      '[Parsed_volumedetect_0 @ 0x7f9b] n_samples: 16000',
      '[Parsed_volumedetect_0 @ 0x7f9b] mean_volume: -23.5 dB',
      '[Parsed_volumedetect_0 @ 0x7f9b] max_volume: -5.2 dB',
    ].join('\n');
    expect(parseMeanVolume(stderr)).toBe(-23.5);
  });

  it('reads the -91.0 dB floor ffmpeg reports for digital silence', () => {
    expect(parseMeanVolume('[Parsed_volumedetect_0 @ 0x1] mean_volume: -91.0 dB')).toBe(-91);
  });

  it('returns null when no reading is present', () => {
    expect(parseMeanVolume('no volume info here')).toBeNull();
    expect(parseMeanVolume('')).toBeNull();
  });
});

describe('transcribeAudio with OpenAI API key', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('skips OpenAI when OPENAI_API_KEY is not set', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('WHISPER_HF_MODEL', '');
    vi.stubEnv('WHISPER_BIN', '');
    vi.stubEnv('PATH', '');
    const result = await transcribeAudio('/nonexistent/audio.wav');
    expect(result).toEqual([]);
  });
});

describe('buildWhisperCliArgs', () => {
  beforeEach(() => {
    // Clear every env the builder reads so defaults are deterministic.
    for (const key of [
      'WHISPER_MODEL',
      'WHISPER_LANGUAGE',
      'WHISPER_PROMPT',
      'WHISPER_DEVICE',
      'WHISPER_COMPUTE',
      'WHISPER_BEAM_SIZE',
      'WHISPER_WORD_TIMESTAMPS',
    ]) {
      vi.stubEnv(key, '');
    }
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

  it('per-call opts take precedence over env for model/language', () => {
    vi.stubEnv('WHISPER_MODEL', 'small');
    vi.stubEnv('WHISPER_LANGUAGE', 'en');
    const args = buildWhisperCliArgs('/audio/clip.wav', '/tmp/out', {
      model: 'medium',
      language: 'pt',
    });
    expect(args[args.indexOf('--model') + 1]).toBe('medium');
    expect(args[args.indexOf('--language') + 1]).toBe('pt');
  });

  it('passes --initial_prompt from WHISPER_PROMPT', () => {
    vi.stubEnv('WHISPER_PROMPT', 'Doha, Smiles, Livelo');
    const args = buildWhisperCliArgs('/audio/clip.wav', '/tmp/out');
    expect(args[args.indexOf('--initial_prompt') + 1]).toBe('Doha, Smiles, Livelo');
  });

  it('per-call initialPrompt overrides WHISPER_PROMPT', () => {
    vi.stubEnv('WHISPER_PROMPT', 'env glossary');
    const args = buildWhisperCliArgs('/audio/clip.wav', '/tmp/out', {
      initialPrompt: 'call glossary',
    });
    expect(args[args.indexOf('--initial_prompt') + 1]).toBe('call glossary');
  });

  it('omits GPU flags unless their env vars are set', () => {
    const args = buildWhisperCliArgs('/audio/clip.wav', '/tmp/out');
    expect(args).not.toContain('--device');
    expect(args).not.toContain('--compute_type');
    expect(args).not.toContain('--beam_size');
    expect(args).not.toContain('--word_timestamps');
  });

  it('emits env-gated GPU/quality flags when set', () => {
    vi.stubEnv('WHISPER_DEVICE', 'cuda');
    vi.stubEnv('WHISPER_COMPUTE', 'float16');
    vi.stubEnv('WHISPER_BEAM_SIZE', '5');
    vi.stubEnv('WHISPER_WORD_TIMESTAMPS', '1');
    const args = buildWhisperCliArgs('/audio/clip.wav', '/tmp/out');
    expect(args[args.indexOf('--device') + 1]).toBe('cuda');
    expect(args[args.indexOf('--compute_type') + 1]).toBe('float16');
    expect(args[args.indexOf('--beam_size') + 1]).toBe('5');
    expect(args[args.indexOf('--word_timestamps') + 1]).toBe('True');
  });

  it('treats falsy WHISPER_WORD_TIMESTAMPS as off', () => {
    vi.stubEnv('WHISPER_WORD_TIMESTAMPS', '0');
    const args = buildWhisperCliArgs('/audio/clip.wav', '/tmp/out');
    expect(args).not.toContain('--word_timestamps');
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
