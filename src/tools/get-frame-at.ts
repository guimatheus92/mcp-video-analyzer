import type { FastMCP } from 'fastmcp';
import { UserError, imageContent } from 'fastmcp';
import { z } from 'zod';
import { getAdapter } from '../adapters/adapter.interface.js';
import { extractBrowserFrames } from '../processors/browser-frame-extractor.js';
import { extractFrameAt, parseTimestamp } from '../processors/frame-extractor.js';
import { optimizeFrame } from '../processors/image-optimizer.js';
import { createProgressReporter } from '../utils/progress.js';
import { createTempDir, getTempFilePath } from '../utils/temp-files.js';
import { isVideoSource, toLocalPath } from '../utils/url-detector.js';

const GetFrameAtSchema = z.object({
  url: z
    .string()
    .refine(isVideoSource, {
      message:
        'Must be a supported video URL (Loom, YouTube, Vimeo, TikTok, Instagram, X/Twitter, Twitch, Dailymotion, Facebook), a direct .mp4/.webm/.mov URL, or an absolute path / file:// URI to a local video file',
    })
    .describe(
      'Video source: Loom share link, platform video URL (YouTube, Vimeo, TikTok, Instagram, X, Twitch, Dailymotion, Facebook), direct .mp4/.webm/.mov URL, or absolute path to a local video file',
    ),
  timestamp: z
    .string()
    .describe('Timestamp to extract frame at (e.g., "1:23", "0:05", "01:23:45")'),
  returnBase64: z
    .boolean()
    .default(false)
    .optional()
    .describe('Return frame as base64 inline instead of file path'),
});

export function registerGetFrameAt(server: FastMCP): void {
  server.addTool({
    name: 'get_frame_at',
    description: `Extract a single video frame at a specific timestamp.

Useful for inspecting what's on screen at a particular moment. The AI reads the transcript,
identifies a critical moment, and requests the exact frame at that timestamp.

Supports: Loom (loom.com/share/...), YouTube/Vimeo/TikTok/Instagram/X/Twitch/Dailymotion/Facebook (requires yt-dlp), direct video URLs (.mp4, .webm, .mov), and local video files (absolute path or file:// URI).

Args:
  - url: Video source (URL or local path)
  - timestamp: Time position (e.g., "1:23", "0:05", "01:23:45")

Returns: A single image of the video frame at the specified timestamp.`,
    parameters: GetFrameAtSchema,
    annotations: {
      title: 'Get Frame at Timestamp',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    execute: async (args, { reportProgress }) => {
      const progress = createProgressReporter(reportProgress);
      const { url, timestamp } = args;

      const adapter = getAdapter(url);

      // Validate the timestamp up front — an invalid timestamp is a caller
      // mistake, so it THROWS (matching analyze_moment and CLAUDE.md's rule),
      // and validating here means neither extraction strategy re-parses it and
      // throws a raw Error later. Only the extraction outcome degrades.
      let seconds: number;
      try {
        seconds = parseTimestamp(timestamp);
      } catch {
        throw new UserError(
          `Invalid timestamp "${timestamp}" — use a form like "1:23", "0:05", or "01:23:45".`,
        );
      }

      await progress(0, 'Starting frame extraction...');

      const tempDir = await createTempDir();
      const warnings: string[] = [];

      // Uniform, parseable response: both the success and the degraded (issue
      // #26) paths emit the same JSON text block, plus any image(s).
      const doc = (frameCount: number) => ({
        type: 'text' as const,
        text: JSON.stringify({ frameCount, timestamp, warnings }, null, 2),
      });
      const zeroFrame = (reason: string) => {
        warnings.push(reason);
        return { content: [doc(0)] };
      };

      // Strategy 1: Download video + ffmpeg extraction
      if (adapter.capabilities.videoDownload) {
        const videoPath = await adapter.downloadVideo(url, tempDir, (w) => warnings.push(w));

        if (videoPath) {
          await progress(50, `Extracting frame at ${timestamp}...`);

          // Wrap ONLY the extractor: it raises a raw ffmpeg Error (leaking the
          // command line) on an undecodable clip. A fixed, path-free reason is
          // surfaced instead of that message.
          let frame;
          try {
            frame = await extractFrameAt(videoPath, tempDir, timestamp);
          } catch {
            return zeroFrame(
              `The video could not be decoded at ${timestamp} — it may be corrupt, truncated, or in an unsupported format.`,
            );
          }

          // An optimize failure must not discard a frame that WAS extracted —
          // fall back to the raw frame (matching get_frames).
          const optimizedPath = getTempFilePath(tempDir, `opt_frame_at.jpg`);
          const framePath = await optimizeFrame(frame.filePath, optimizedPath)
            .then(() => optimizedPath)
            .catch(() => frame.filePath);

          await progress(100, 'Frame extracted');
          return { content: [doc(1), await imageContent({ path: framePath })] };
        }
      }

      // Strategy 2: Browser-based extraction (fallback) — not applicable to
      // local files (puppeteer.goto() can't load fs paths reliably).
      if (toLocalPath(url) !== null) {
        return zeroFrame(
          'Failed to extract frame from local video. Install ffmpeg or check that the file is a valid video.',
        );
      }

      await progress(30, 'Extracting frame via browser fallback...');
      const browserFrames = await extractBrowserFrames(url, tempDir, {
        timestamps: [seconds],
      }).catch((e: unknown) => {
        warnings.push(`Browser extraction failed: ${e instanceof Error ? e.name : 'error'}`);
        return [];
      });

      if (browserFrames.length > 0) {
        await progress(100, 'Frame extracted');
        return { content: [doc(1), await imageContent({ path: browserFrames[0].filePath })] };
      }

      return zeroFrame(
        'Failed to extract frame. Install yt-dlp or Chrome/Chromium for frame extraction.',
      );
    },
  });
}
