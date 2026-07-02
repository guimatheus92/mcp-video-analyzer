import type { FastMCP } from 'fastmcp';
import { UserError, imageContent } from 'fastmcp';
import { z } from 'zod';
import { getAdapter } from '../adapters/adapter.interface.js';
import { extractBrowserFrames } from '../processors/browser-frame-extractor.js';
import { extractFrameBurst, parseTimestamp } from '../processors/frame-extractor.js';
import { optimizeFrames } from '../processors/image-optimizer.js';
import { createProgressReporter } from '../utils/progress.js';
import { createTempDir } from '../utils/temp-files.js';
import { isVideoSource, toLocalPath } from '../utils/url-detector.js';

const GetFrameBurstSchema = z.object({
  url: z
    .string()
    .refine(isVideoSource, {
      message:
        'Must be a supported video URL (Loom, YouTube, Vimeo, TikTok, Instagram, X/Twitter, Twitch, Dailymotion, Facebook), a direct .mp4/.webm/.mov URL, or an absolute path / file:// URI to a local video file',
    })
    .describe(
      'Video source: Loom share link, platform video URL (YouTube, Vimeo, TikTok, Instagram, X, Twitch, Dailymotion, Facebook), direct .mp4/.webm/.mov URL, or absolute path to a local video file',
    ),
  from: z.string().describe('Start timestamp (e.g., "0:15")'),
  to: z.string().describe('End timestamp (e.g., "0:17")'),
  count: z
    .number()
    .min(2)
    .max(30)
    .default(5)
    .optional()
    .describe('Number of frames to extract (default: 5)'),
  returnBase64: z
    .boolean()
    .default(false)
    .optional()
    .describe('Return frames as base64 inline instead of file paths'),
});

export function registerGetFrameBurst(server: FastMCP): void {
  server.addTool({
    name: 'get_frame_burst',
    description: `Extract multiple frames evenly distributed across a time range.

Designed for motion and vibration analysis where scene-change detection fails because
the "scene" doesn't change — only the position/state of objects does.

Example: get_frame_burst(url, "0:15", "0:17", 10) → 10 frames in 2 seconds
- AI sees the object in different positions across frames → understands the vibration
- Works for: shaking, flickering, animations, fast scrolling, loading spinners

Supports: Loom (loom.com/share/...), YouTube/Vimeo/TikTok/Instagram/X/Twitch/Dailymotion/Facebook (requires yt-dlp), direct video URLs (.mp4, .webm, .mov), and local video files (absolute path or file:// URI).

Args:
  - url: Video source (URL or local path)
  - from: Start timestamp (e.g., "0:15")
  - to: End timestamp (e.g., "0:17")
  - count: Number of frames (default: 5, max: 30)

Returns: N images evenly distributed between the from and to timestamps.`,
    parameters: GetFrameBurstSchema,
    annotations: {
      title: 'Get Frame Burst',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    execute: async (args, { reportProgress }) => {
      const progress = createProgressReporter(reportProgress);
      const { url, from, to, count } = args;
      const frameCount = count ?? 5;

      const adapter = getAdapter(url);

      await progress(0, `Starting burst extraction (${from} → ${to})...`);

      const tempDir = await createTempDir();

      // Strategy 1: Download video + ffmpeg burst extraction
      if (adapter.capabilities.videoDownload) {
        const videoPath = await adapter.downloadVideo(url, tempDir);

        if (videoPath) {
          await progress(40, 'Video downloaded, extracting burst frames...');

          const frames = await extractFrameBurst(videoPath, tempDir, from, to, frameCount);

          await progress(70, `Extracted ${frames.length} frames, optimizing...`);

          const optimizedPaths = await optimizeFrames(
            frames.map((f) => f.filePath),
            tempDir,
          );

          await progress(100, 'Burst extraction complete');

          const content: (
            | { type: 'text'; text: string }
            | Awaited<ReturnType<typeof imageContent>>
          )[] = [
            {
              type: 'text' as const,
              text: `Extracted ${optimizedPaths.length} frames from ${from} to ${to}`,
            },
          ];

          for (const path of optimizedPaths) {
            content.push(await imageContent({ path }));
          }

          return { content };
        }
      }

      // Strategy 2: Browser-based extraction (fallback) — not applicable to
      // local files (puppeteer.goto() can't load fs paths reliably).
      if (toLocalPath(url) !== null) {
        throw new UserError(
          'Failed to extract frames from local video. Install ffmpeg or check that the file is a valid video.',
        );
      }

      await progress(30, 'Extracting frames via browser fallback...');
      const fromSeconds = parseTimestamp(from);
      const toSeconds = parseTimestamp(to);
      const interval = (toSeconds - fromSeconds) / Math.max(frameCount - 1, 1);
      const timestamps = Array.from({ length: frameCount }, (_, i) =>
        Math.round(fromSeconds + i * interval),
      );

      const browserFrames = await extractBrowserFrames(url, tempDir, { timestamps });

      if (browserFrames.length > 0) {
        await progress(100, 'Burst extraction complete');

        const content: (
          | { type: 'text'; text: string }
          | Awaited<ReturnType<typeof imageContent>>
        )[] = [
          {
            type: 'text' as const,
            text: `Extracted ${browserFrames.length} frames from ${from} to ${to} (via browser)`,
          },
        ];

        for (const frame of browserFrames) {
          content.push(await imageContent({ path: frame.filePath }));
        }

        return { content };
      }

      throw new UserError(
        'Failed to extract frames. Install yt-dlp or Chrome/Chromium for frame extraction.',
      );
    },
  });
}
