import type { FastMCP } from 'fastmcp';
import { UserError, imageContent } from 'fastmcp';
import { z } from 'zod';
import { getAdapter } from '../adapters/adapter.interface.js';
import { extractBrowserFrames } from '../processors/browser-frame-extractor.js';
import { extractFrameAt, parseTimestamp } from '../processors/frame-extractor.js';
import { optimizeFrame } from '../processors/image-optimizer.js';
import { createTempDir } from '../utils/temp-files.js';
import { getTempFilePath } from '../utils/temp-files.js';

const GetFrameAtSchema = z.object({
  url: z.string().url().describe('Video URL (Loom share link or direct mp4/webm URL)'),
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

Supports: Loom (loom.com/share/...) and direct video URLs (.mp4, .webm, .mov).
Requires video download capability — direct URLs work best.

Args:
  - url: Video URL
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
      const { url, timestamp } = args;

      const adapter = getAdapter(url);

      await reportProgress({ progress: 0, total: 100 });

      const tempDir = await createTempDir();

      // Strategy 1: Download video + ffmpeg extraction
      if (adapter.capabilities.videoDownload) {
        const videoPath = await adapter.downloadVideo(url, tempDir);

        if (videoPath) {
          await reportProgress({ progress: 50, total: 100 });

          const frame = await extractFrameAt(videoPath, tempDir, timestamp);
          const optimizedPath = getTempFilePath(tempDir, `opt_frame_at.jpg`);
          await optimizeFrame(frame.filePath, optimizedPath);

          await reportProgress({ progress: 100, total: 100 });

          return {
            content: [
              { type: 'text' as const, text: `Frame extracted at ${timestamp}` },
              await imageContent({ path: optimizedPath }),
            ],
          };
        }
      }

      // Strategy 2: Browser-based extraction (fallback)
      await reportProgress({ progress: 30, total: 100 });
      const seconds = parseTimestamp(timestamp);
      const browserFrames = await extractBrowserFrames(url, tempDir, {
        timestamps: [seconds],
      });

      if (browserFrames.length > 0) {
        await reportProgress({ progress: 100, total: 100 });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Frame extracted at ${timestamp} (via browser)`,
            },
            await imageContent({ path: browserFrames[0].filePath }),
          ],
        };
      }

      throw new UserError(
        'Failed to extract frame. Install yt-dlp or Chrome/Chromium for frame extraction.',
      );
    },
  });
}
