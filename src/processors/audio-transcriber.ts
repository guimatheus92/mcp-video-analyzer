import { execFile as execFileCb } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, extname, join } from 'node:path';
import { promisify } from 'node:util';
import type { ITranscriptEntry } from '../types.js';
import { formatTimestamp } from './frame-extractor.js';

const execFile = promisify(execFileCb);

const require = createRequire(import.meta.url);
const ffmpegPath: string = require('ffmpeg-static') as string;

/**
 * Extract the audio track from a video file as a 16kHz mono WAV.
 * This is the format expected by most speech recognition engines.
 */
export async function extractAudioTrack(videoPath: string, outputDir: string): Promise<string> {
  const outputPath = join(outputDir, 'audio.wav');

  try {
    await execFile(
      ffmpegPath,
      [
        '-i',
        videoPath,
        '-vn',
        '-acodec',
        'pcm_s16le',
        '-ar',
        '16000',
        '-ac',
        '1',
        outputPath,
        '-y',
      ],
      { timeout: 120000 },
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Audio extraction failed: ${msg}`, { cause: error });
  }

  return outputPath;
}

/**
 * Transcribe an audio file using the best available strategy.
 *
 * Strategy chain (graceful fallback):
 * 1. @huggingface/transformers (JS-native, zero external deps;
 *    model via WHISPER_HF_MODEL, default Xenova/whisper-tiny)
 * 2. whisper CLI (requires Python + whisper installed globally;
 *    model via WHISPER_MODEL, language via WHISPER_LANGUAGE)
 * 3. OpenAI Whisper API (requires OPENAI_API_KEY env var)
 * 4. Returns [] if nothing is available
 */
export async function transcribeAudio(audioPath: string): Promise<ITranscriptEntry[]> {
  // Strategy 1: @huggingface/transformers (JS-native whisper)
  const hfResult = await transcribeWithHuggingFace(audioPath);
  if (hfResult) return hfResult;

  // Strategy 2: whisper CLI
  const cliResult = await transcribeWithWhisperCli(audioPath);
  if (cliResult) return cliResult;

  // Strategy 3: OpenAI Whisper API
  const apiResult = await transcribeWithOpenAiApi(audioPath);
  if (apiResult) return apiResult;

  // No transcription strategy available
  return [];
}

async function transcribeWithHuggingFace(audioPath: string): Promise<ITranscriptEntry[] | null> {
  const transformers = await loadTransformers();
  if (!transformers) return null;

  try {
    const { pipeline } = transformers;
    const hfModel = process.env.WHISPER_HF_MODEL || 'Xenova/whisper-tiny';
    const transcriber = await pipeline('automatic-speech-recognition', hfModel, {
      return_timestamps: true,
    });

    const result = await transcriber(audioPath, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    });

    if (!result || typeof result !== 'object') return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chunks = (result as any).chunks ?? [];
    if (!Array.isArray(chunks) || chunks.length === 0) {
      // Might be a simple text result
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const text = (result as any).text;
      if (typeof text === 'string' && text.trim().length > 0) {
        return [{ time: '0:00', text: text.trim() }];
      }
      return null;
    }

    return (
      chunks
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((chunk: any) => typeof chunk.text === 'string' && chunk.text.trim().length > 0)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((chunk: any) => ({
          time: formatTimestamp(Math.round(chunk.timestamp?.[0] ?? 0)),
          text: chunk.text.trim(),
        }))
    );
  } catch {
    return null;
  }
}

/**
 * Build the argument list for the `whisper` CLI.
 *
 * Model defaults to `tiny` but can be overridden with WHISPER_MODEL (e.g. `small`,
 * `medium` for much better non-English accuracy). WHISPER_LANGUAGE forces a language
 * (e.g. `pt`) instead of relying on auto-detection.
 */
export function buildWhisperCliArgs(audioPath: string, outputDir: string): string[] {
  const model = process.env.WHISPER_MODEL || 'tiny';
  const args = [audioPath, '--output_format', 'json', '--model', model, '--output_dir', outputDir];

  const language = process.env.WHISPER_LANGUAGE;
  if (language) {
    args.push('--language', language);
  }

  return args;
}

/**
 * Parse the JSON Whisper writes with `--output_format json` into transcript
 * entries. Exported for testing. Returns null when there are no usable segments.
 */
export function parseWhisperJson(raw: string): ITranscriptEntry[] | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (!Array.isArray(parsed['segments'])) return null;

  return (parsed['segments'] as Record<string, unknown>[])
    .filter((seg) => typeof seg['text'] === 'string' && (seg['text'] as string).trim().length > 0)
    .map((seg) => ({
      time: formatTimestamp(Math.round((seg['start'] as number) ?? 0)),
      text: (seg['text'] as string).trim(),
    }));
}

async function transcribeWithWhisperCli(audioPath: string): Promise<ITranscriptEntry[] | null> {
  const whisperCmd = await findWhisperCommand();
  if (!whisperCmd) return null;

  const outputDir = tmpdir();
  // whisper writes the transcript to <outputDir>/<base>.json — not to stdout.
  const jsonPath = join(outputDir, `${basename(audioPath, extname(audioPath))}.json`);

  try {
    // whisper (Python) shells out to `ffmpeg` to decode audio. Put the bundled
    // ffmpeg-static binary on PATH so no system ffmpeg install is required.
    const env = {
      ...process.env,
      PATH: `${dirname(ffmpegPath)}${delimiter}${process.env.PATH ?? ''}`,
    };
    await execFile(whisperCmd, buildWhisperCliArgs(audioPath, outputDir), {
      timeout: 300000,
      env,
    });
    return parseWhisperJson(await readFile(jsonPath, 'utf-8'));
  } catch {
    return null;
  } finally {
    // Best-effort cleanup of the temp transcript file.
    await rm(jsonPath, { force: true }).catch(() => undefined);
  }
}

async function transcribeWithOpenAiApi(audioPath: string): Promise<ITranscriptEntry[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const audioBuffer = await readFile(audioPath);
    const blob = new Blob([audioBuffer], { type: 'audio/wav' });

    const formData = new FormData();
    formData.append('file', blob, 'audio.wav');
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'segment');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (!response.ok) return null;

    const data = (await response.json()) as Record<string, unknown>;

    if (Array.isArray(data['segments'])) {
      return (data['segments'] as Record<string, unknown>[])
        .filter(
          (seg) => typeof seg['text'] === 'string' && (seg['text'] as string).trim().length > 0,
        )
        .map((seg) => ({
          time: formatTimestamp(Math.round((seg['start'] as number) ?? 0)),
          text: (seg['text'] as string).trim(),
        }));
    }

    // Fallback: if only text is returned (no segments)
    if (typeof data['text'] === 'string' && (data['text'] as string).trim().length > 0) {
      return [{ time: '0:00', text: (data['text'] as string).trim() }];
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Locate a usable `whisper` executable. WHISPER_BIN can point at an explicit
 * path (useful on Windows, where the Python Scripts dir is often not on the
 * PATH that GUI-launched processes inherit). Otherwise falls back to `whisper`
 * on PATH.
 */
async function findWhisperCommand(): Promise<string | null> {
  const candidates = [process.env.WHISPER_BIN, 'whisper'].filter(
    (c): c is string => typeof c === 'string' && c.length > 0,
  );

  for (const cmd of candidates) {
    try {
      await execFile(cmd, ['--help'], { timeout: 5000 });
      return cmd;
    } catch {
      continue;
    }
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadTransformers(): Promise<any> {
  try {
    // Dynamic import — package is optional, not in dependencies
    return await import(/* webpackIgnore: true */ '@huggingface/transformers' + '');
  } catch {
    return null;
  }
}
