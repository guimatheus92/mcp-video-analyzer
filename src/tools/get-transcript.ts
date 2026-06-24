import type { FastMCP } from 'fastmcp';
import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getAdapter } from '../adapters/adapter.interface.js';
import { extractAudioTrack, transcribeAudio } from '../processors/audio-transcriber.js';
import { createProgressReporter } from '../utils/progress.js';
import { cleanupTempDir, createTempDir } from '../utils/temp-files.js';
import { isVideoSource } from '../utils/url-detector.js';

const GetTranscriptSchema = z.object({
  url: z
    .string()
    .refine(isVideoSource, {
      message:
        'Must be a Loom share URL, a direct .mp4/.webm/.mov URL, or an absolute path / file:// URI to a local video file',
    })
    .describe(
      'Video source: Loom share link, direct .mp4/.webm/.mov URL, or absolute path to a local video file',
    ),
  options: z
    .object({
      model: z
        .string()
        .optional()
        .describe(
          'Whisper model for the transcription fallback (overrides WHISPER_MODEL for this call), e.g. "small", "medium".',
        ),
      language: z
        .string()
        .optional()
        .describe('Forced transcription language code (overrides WHISPER_LANGUAGE), e.g. "pt".'),
      initialPrompt: z
        .string()
        .optional()
        .describe(
          'Domain glossary fed to Whisper as --initial_prompt (overrides WHISPER_PROMPT). Fixes proper nouns in the transcript.',
        ),
    })
    .optional()
    .describe('Transcription overrides (apply only to the Whisper fallback)'),
});

export function registerGetTranscript(server: FastMCP): void {
  server.addTool({
    name: 'get_transcript',
    description: `Extract only the transcript from a video URL.

Returns timestamped transcript entries with speaker identification (when available).
Faster than analyze_video when you only need the transcript.

If the platform has no native transcript, attempts Whisper fallback transcription
(requires @huggingface/transformers, whisper CLI, or OPENAI_API_KEY).

Supports: Loom (loom.com/share/...), direct video URLs (.mp4, .webm, .mov), and local video files (absolute path or file:// URI). For local files a sidecar .vtt/.srt next to the file is used first, then an embedded subtitle track, and only then the Whisper fallback if neither exists.`,
    parameters: GetTranscriptSchema,
    annotations: {
      title: 'Get Transcript',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    execute: async (args, { reportProgress }) => {
      const progress = createProgressReporter(reportProgress);
      const { url, options } = args;
      const transcribeOpts = {
        model: options?.model,
        language: options?.language,
        initialPrompt: options?.initialPrompt,
      };

      let adapter;
      try {
        adapter = getAdapter(url);
      } catch (error) {
        if (error instanceof UserError) throw error;
        throw new UserError(`Failed to detect video platform for URL: ${url}`);
      }

      const warnings: string[] = [];

      await progress(0, 'Fetching transcript...');

      // Try native transcript first
      let transcript = await adapter.getTranscript(url).catch((e: unknown) => {
        warnings.push(
          `Failed to fetch native transcript: ${e instanceof Error ? e.message : String(e)}`,
        );
        return [];
      });

      await progress(40, 'Native transcript fetched');

      // Whisper fallback if no native transcript.
      if (transcript.length === 0 && adapter.capabilities.videoDownload) {
        // Skip the fallback if the source advertises no audio track —
        // a metadata probe is cheap; transcription is not.
        const hasAudio = await adapter
          .getMetadata(url)
          .then((m) => m.hasAudio)
          .catch(() => undefined);

        if (hasAudio === false) {
          warnings.push(
            'No audio track detected by the probe — skipped Whisper transcription. If the video does have audio, the probe may not have recognized the stream.',
          );
        } else {
          let tempDir: string | null = null;
          try {
            await progress(45, 'No native transcript, downloading video for Whisper...');
            tempDir = await createTempDir();
            const videoPath = await adapter.downloadVideo(url, tempDir);
            if (videoPath) {
              await progress(65, 'Transcribing audio with Whisper...');
              const audioPath = await extractAudioTrack(videoPath, tempDir);
              transcript = await transcribeAudio(audioPath, transcribeOpts);
              if (transcript.length > 0) {
                warnings.push(
                  'Transcript generated via Whisper fallback (no native transcript available).',
                );
              }
            }
          } catch {
            // Whisper fallback failed — not critical
          } finally {
            if (tempDir) await cleanupTempDir(tempDir).catch(() => undefined);
          }
        }
      }

      if (transcript.length === 0) {
        warnings.push('No transcript available for this video.');
      }

      await progress(100, 'Transcript complete');

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ transcript, warnings }, null, 2),
          },
        ],
      };
    },
  });
}
