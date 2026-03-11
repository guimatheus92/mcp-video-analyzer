import { execFile as execFileCb } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
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
 * 1. @huggingface/transformers (whisper-tiny, JS-native, zero external deps)
 * 2. whisper CLI (requires Python + whisper installed globally)
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
    const transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', {
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

async function transcribeWithWhisperCli(audioPath: string): Promise<ITranscriptEntry[] | null> {
  const whisperCmd = await findWhisperCommand();
  if (!whisperCmd) return null;

  try {
    const { stdout } = await execFile(
      whisperCmd,
      [audioPath, '--output_format', 'json', '--model', 'tiny', '--output_dir', '/tmp'],
      { timeout: 300000 },
    );

    // Parse whisper JSON output
    try {
      const parsed = JSON.parse(stdout);
      if (Array.isArray(parsed.segments)) {
        return (
          parsed.segments
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .filter((seg: any) => typeof seg.text === 'string' && seg.text.trim().length > 0)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((seg: any) => ({
              time: formatTimestamp(Math.round(seg.start ?? 0)),
              text: seg.text.trim(),
            }))
        );
      }
    } catch {
      // stdout wasn't JSON; ignore
    }

    return null;
  } catch {
    return null;
  }
}

async function transcribeWithOpenAiApi(audioPath: string): Promise<ITranscriptEntry[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const { readFile } = await import('node:fs/promises');
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

async function findWhisperCommand(): Promise<string | null> {
  for (const cmd of ['whisper', 'python -m whisper']) {
    try {
      await execFile(cmd.split(' ')[0], [...cmd.split(' ').slice(1), '--help'], { timeout: 5000 });
      return cmd.split(' ')[0];
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
