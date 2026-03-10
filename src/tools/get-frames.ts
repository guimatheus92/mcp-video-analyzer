import type { FastMCP } from 'fastmcp';
import { imageContent, UserError } from 'fastmcp';
import { z } from 'zod';
import { getAdapter } from '../adapters/adapter.interface.js';
import {
  extractSceneFrames,
  extractDenseFrames,
  probeVideoDuration,
  formatTimestamp,
} from '../processors/frame-extractor.js';
import { extractBrowserFrames, generateTimestamps } from '../processors/browser-frame-extractor.js';
import { deduplicateFrames } from '../processors/frame-dedup.js';
import { optimizeFrames } from '../processors/image-optimizer.js';
import { createTempDir } from '../utils/temp-files.js';

const GetFramesSchema = z.object({
  url: z.string().url().describe('Video URL (Loom share link or direct mp4/webm URL)'),
  options: z
    .object({
      maxFrames: z
        .number()
        .min(1)
        .max(60)
        .default(20)
        .optional()
        .describe('Maximum number of frames to extract (default: 20)'),
      threshold: z
        .number()
        .min(0)
        .max(1)
        .default(0.1)
        .optional()
        .describe('Scene-change sensitivity 0.0-1.0 (default: 0.1)'),
      dense: z
        .boolean()
        .default(false)
        .optional()
        .describe('Use dense sampling (1 frame/sec) instead of scene-change detection'),
    })
    .optional(),
});

export function registerGetFrames(server: FastMCP): void {
  server.addTool({
    name: 'get_frames',
    description: `Extract key frames from a video URL without transcript or metadata.

Two extraction modes:
- Scene-change detection (default): captures visual transitions
- Dense sampling (dense=true): captures 1 frame/sec for full video coverage

Returns optimized, deduplicated JPEG frames.

Supports: Loom (loom.com/share/...) and direct video URLs (.mp4, .webm, .mov).`,
    parameters: GetFramesSchema,
    annotations: {
      title: 'Get Frames',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    execute: async (args, { reportProgress }) => {
      const { url, options } = args;
      const maxFrames = options?.maxFrames ?? 20;
      const threshold = options?.threshold ?? 0.1;
      const dense = options?.dense ?? false;

      let adapter;
      try {
        adapter = getAdapter(url);
      } catch (error) {
        if (error instanceof UserError) throw error;
        throw new UserError(`Failed to detect video platform for URL: ${url}`);
      }

      const warnings: string[] = [];
      const tempDir = await createTempDir();

      await reportProgress({ progress: 0, total: 100 });

      // Get metadata for duration (needed for browser fallback)
      const metadata = await adapter.getMetadata(url).catch(() => ({
        platform: adapter.name as 'loom' | 'direct' | 'unknown',
        title: 'Unknown',
        duration: 0,
        durationFormatted: '0:00',
        url,
      }));

      let frames: { time: string; filePath: string; mimeType: string }[] = [];

      // Strategy 1: Download + ffmpeg
      if (adapter.capabilities.videoDownload) {
        const videoPath = await adapter.downloadVideo(url, tempDir);
        if (videoPath) {
          await reportProgress({ progress: 50, total: 100 });

          if (metadata.duration === 0) {
            const duration = await probeVideoDuration(videoPath).catch(() => 0);
            metadata.duration = duration;
            metadata.durationFormatted = formatTimestamp(Math.floor(duration));
          }

          const rawFrames = dense
            ? await extractDenseFrames(videoPath, tempDir, { maxFrames }).catch((e: unknown) => {
                warnings.push(
                  `Dense extraction failed: ${e instanceof Error ? e.message : String(e)}`,
                );
                return [];
              })
            : await extractSceneFrames(videoPath, tempDir, { threshold, maxFrames }).catch(
                (e: unknown) => {
                  warnings.push(
                    `Scene extraction failed: ${e instanceof Error ? e.message : String(e)}`,
                  );
                  return [];
                },
              );

          if (rawFrames.length > 0) {
            const optimizedPaths = await optimizeFrames(
              rawFrames.map((f) => f.filePath),
              tempDir,
            ).catch(() => rawFrames.map((f) => f.filePath));

            frames = rawFrames.map((frame, i) => ({
              ...frame,
              filePath: optimizedPaths[i] ?? frame.filePath,
            }));
          }
        }
      }

      // Strategy 2: Browser fallback
      if (frames.length === 0 && metadata.duration > 0) {
        await reportProgress({ progress: 50, total: 100 });
        const timestamps = generateTimestamps(metadata.duration, maxFrames);
        frames = await extractBrowserFrames(url, tempDir, { timestamps }).catch((e: unknown) => {
          warnings.push(`Browser extraction failed: ${e instanceof Error ? e.message : String(e)}`);
          return [];
        });
      }

      // Dedup
      if (frames.length > 0) {
        const before = frames.length;
        frames = await deduplicateFrames(frames).catch(() => frames);
        if (frames.length < before) {
          warnings.push(`Removed ${before - frames.length} duplicate frames`);
        }
      }

      await reportProgress({ progress: 100, total: 100 });

      if (frames.length === 0) {
        throw new UserError(
          'Could not extract any frames. Install yt-dlp or Chrome/Chromium for frame extraction.',
        );
      }

      const content: ({ type: 'text'; text: string } | Awaited<ReturnType<typeof imageContent>>)[] =
        [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { frameCount: frames.length, mode: dense ? 'dense' : 'scene', warnings },
              null,
              2,
            ),
          },
        ];

      for (const frame of frames) {
        content.push(await imageContent({ path: frame.filePath }));
      }

      return { content };
    },
  });
}
