import type { FastMCP } from 'fastmcp';
import { UserError, imageContent } from 'fastmcp';
import { z } from 'zod';
import { getAdapter } from '../adapters/adapter.interface.js';
import { extractBrowserFrames, generateTimestamps } from '../processors/browser-frame-extractor.js';
import { deduplicateFrames, filterBlackFrames } from '../processors/frame-dedup.js';
import {
  extractKeyFrames,
  formatTimestamp,
  probeVideoDuration,
} from '../processors/frame-extractor.js';
import { optimizeFrames } from '../processors/image-optimizer.js';
import { createProgressReporter } from '../utils/progress.js';
import { createTempDir } from '../utils/temp-files.js';
import { isVideoSource, toLocalPath } from '../utils/url-detector.js';

const GetFramesSchema = z.object({
  url: z
    .string()
    .refine(isVideoSource, {
      message:
        'Must be a supported video URL (Loom, YouTube, Vimeo, TikTok, Instagram, X/Twitter, Twitch, Dailymotion, Facebook), a direct .mp4/.webm/.mov URL, or an absolute path / file:// URI to a local video file',
    })
    .describe(
      'Video source: Loom share link, platform video URL (YouTube, Vimeo, TikTok, Instagram, X, Twitch, Dailymotion, Facebook), direct .mp4/.webm/.mov URL, or absolute path to a local video file',
    ),
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

Supports: Loom (loom.com/share/...), YouTube/Vimeo/TikTok/Instagram/X/Twitch/Dailymotion/Facebook (requires yt-dlp), direct video URLs (.mp4, .webm, .mov), and local video files (absolute path or file:// URI).`,
    parameters: GetFramesSchema,
    annotations: {
      title: 'Get Frames',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    execute: async (args, { reportProgress }) => {
      const progress = createProgressReporter(reportProgress);
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

      await progress(0, 'Starting frame extraction...');

      // Get metadata for duration (needed for browser fallback)
      const metadata = await adapter.getMetadata(url).catch(() => ({
        platform: adapter.name,
        title: 'Unknown',
        duration: 0,
        durationFormatted: '0:00',
        url,
      }));

      let frames: { time: string; filePath: string; mimeType: string }[] = [];

      // Strategy 1: Download + ffmpeg
      if (adapter.capabilities.videoDownload) {
        const videoPath = await adapter.downloadVideo(url, tempDir, (w) => warnings.push(w));
        if (videoPath) {
          await progress(40, 'Video downloaded, extracting frames...');

          if (metadata.duration === 0) {
            const duration = await probeVideoDuration(videoPath).catch(() => 0);
            metadata.duration = duration;
            metadata.durationFormatted = formatTimestamp(Math.floor(duration));
          }

          const extraction = await extractKeyFrames(videoPath, tempDir, {
            threshold,
            maxFrames,
            dense,
          });
          const rawFrames = extraction.frames;
          warnings.push(...extraction.warnings);

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

      // Strategy 2: Browser fallback — skipped for local files since
      // puppeteer.goto() can't load fs paths reliably.
      const isLocal = toLocalPath(url) !== null;
      if (frames.length === 0 && !isLocal && metadata.duration > 0) {
        await progress(40, 'Extracting frames via browser fallback...');
        const timestamps = generateTimestamps(metadata.duration, maxFrames);
        frames = await extractBrowserFrames(url, tempDir, { timestamps }).catch((e: unknown) => {
          warnings.push(`Browser extraction failed: ${e instanceof Error ? e.message : String(e)}`);
          return [];
        });
      }

      // Filter black/blank frames
      await progress(80, 'Filtering and deduplicating frames...');
      if (frames.length > 0) {
        const blackResult = await filterBlackFrames(frames).catch(() => ({
          frames,
          removedCount: 0,
        }));
        if (blackResult.removedCount > 0) {
          warnings.push(
            `Removed ${blackResult.removedCount} black/blank frame(s) — video may be DRM-protected`,
          );
        }
        frames = blackResult.frames;
      }

      // Dedup
      if (frames.length > 0) {
        const before = frames.length;
        frames = await deduplicateFrames(frames).catch(() => frames);
        if (frames.length < before) {
          warnings.push(`Removed ${before - frames.length} duplicate frames`);
        }
      }

      await progress(100, 'Frames extracted');

      // Degrade like analyze_video rather than throwing: a zero-frame result
      // (extraction failure OR everything filtered as black/duplicate) returns
      // frameCount: 0 with the accumulated warnings — which carry the real,
      // actionable reason. The old throw discarded that whole `warnings` array
      // and emitted a generic message (issue #26).
      if (frames.length === 0) {
        warnings.push(
          isLocal
            ? 'Could not extract any frames from this local file — ffmpeg produced no frames (the file may be unreadable, zero-length, or have no decodable video stream).'
            : 'Could not extract any frames. Install yt-dlp or Chrome/Chromium for frame extraction.',
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
