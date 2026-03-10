import type { FastMCP } from 'fastmcp';
import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getAdapter } from '../adapters/adapter.interface.js';
import { extractAudioTrack, transcribeAudio } from '../processors/audio-transcriber.js';
import { createTempDir, cleanupTempDir } from '../utils/temp-files.js';

const GetTranscriptSchema = z.object({
  url: z.string().url().describe('Video URL (Loom share link or direct mp4/webm URL)'),
});

export function registerGetTranscript(server: FastMCP): void {
  server.addTool({
    name: 'get_transcript',
    description: `Extract only the transcript from a video URL.

Returns timestamped transcript entries with speaker identification (when available).
Faster than analyze_video when you only need the transcript.

If the platform has no native transcript, attempts Whisper fallback transcription
(requires @huggingface/transformers, whisper CLI, or OPENAI_API_KEY).

Supports: Loom (loom.com/share/...) and direct video URLs (.mp4, .webm, .mov).`,
    parameters: GetTranscriptSchema,
    annotations: {
      title: 'Get Transcript',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    execute: async (args) => {
      const { url } = args;

      let adapter;
      try {
        adapter = getAdapter(url);
      } catch (error) {
        if (error instanceof UserError) throw error;
        throw new UserError(`Failed to detect video platform for URL: ${url}`);
      }

      const warnings: string[] = [];

      // Try native transcript first
      let transcript = await adapter.getTranscript(url).catch((e: unknown) => {
        warnings.push(
          `Failed to fetch native transcript: ${e instanceof Error ? e.message : String(e)}`,
        );
        return [];
      });

      // Whisper fallback if no native transcript
      if (transcript.length === 0 && adapter.capabilities.videoDownload) {
        let tempDir: string | null = null;
        try {
          tempDir = await createTempDir();
          const videoPath = await adapter.downloadVideo(url, tempDir);
          if (videoPath) {
            const audioPath = await extractAudioTrack(videoPath, tempDir);
            transcript = await transcribeAudio(audioPath);
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

      if (transcript.length === 0) {
        warnings.push('No transcript available for this video.');
      }

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
