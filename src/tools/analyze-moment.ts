import type { FastMCP } from 'fastmcp';
import { imageContent, UserError } from 'fastmcp';
import { z } from 'zod';
import { getAdapter } from '../adapters/adapter.interface.js';
import { extractFrameBurst, parseTimestamp } from '../processors/frame-extractor.js';
import { deduplicateFrames } from '../processors/frame-dedup.js';
import { extractTextFromFrames } from '../processors/frame-ocr.js';
import { buildAnnotatedTimeline } from '../processors/annotated-timeline.js';
import { optimizeFrames } from '../processors/image-optimizer.js';
import { createTempDir } from '../utils/temp-files.js';

const AnalyzeMomentSchema = z.object({
  url: z.string().url().describe('Video URL (Loom share link or direct mp4/webm URL)'),
  from: z.string().describe('Start timestamp (e.g., "1:30")'),
  to: z.string().describe('End timestamp (e.g., "2:00")'),
  count: z
    .number()
    .min(2)
    .max(30)
    .default(10)
    .optional()
    .describe('Number of frames to extract in the range (default: 10)'),
});

export function registerAnalyzeMoment(server: FastMCP): void {
  server.addTool({
    name: 'analyze_moment',
    description: `Deep-dive analysis of a specific time range in a video.

Combines burst frame extraction + transcript filtering + OCR + annotated timeline
for a focused segment of the video.

Use this when you need to understand exactly what happens between two timestamps:
- What's on screen (frames + OCR text extraction)
- What's being said (transcript filtered to the range)
- Unified timeline merging visual and audio content

Example: analyze_moment(url, "1:30", "2:00", 10) → 10 frames + transcript + OCR for that 30s window

Supports: Loom (loom.com/share/...) and direct video URLs (.mp4, .webm, .mov).
Requires video download capability for frame extraction.`,
    parameters: AnalyzeMomentSchema,
    annotations: {
      title: 'Analyze Moment',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    execute: async (args, { reportProgress }) => {
      const { url, from, to } = args;
      const count = args.count ?? 10;

      // Validate timestamps
      const fromSeconds = parseTimestamp(from);
      const toSeconds = parseTimestamp(to);

      if (fromSeconds >= toSeconds) {
        throw new UserError(
          `"from" timestamp (${from} = ${fromSeconds}s) must be before "to" timestamp (${to} = ${toSeconds}s)`,
        );
      }

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

      // Fetch transcript and filter to time range
      const fullTranscript = await adapter.getTranscript(url).catch((e: unknown) => {
        warnings.push(`Failed to fetch transcript: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      });

      const transcriptSegment = fullTranscript.filter((entry) => {
        const entrySeconds = parseTimestampLoose(entry.time);
        return entrySeconds !== null && entrySeconds >= fromSeconds && entrySeconds <= toSeconds;
      });

      await reportProgress({ progress: 20, total: 100 });

      // Download video and extract burst frames
      if (!adapter.capabilities.videoDownload) {
        throw new UserError(
          'Moment analysis requires video download capability. Use a direct video URL (.mp4, .webm, .mov).',
        );
      }

      const videoPath = await adapter.downloadVideo(url, tempDir);
      if (!videoPath) {
        throw new UserError('Failed to download video for moment analysis.');
      }

      await reportProgress({ progress: 40, total: 100 });

      const rawFrames = await extractFrameBurst(videoPath, tempDir, from, to, count);

      await reportProgress({ progress: 60, total: 100 });

      // Optimize frames
      const optimizedPaths = await optimizeFrames(
        rawFrames.map((f) => f.filePath),
        tempDir,
      ).catch((e: unknown) => {
        warnings.push(`Frame optimization failed: ${e instanceof Error ? e.message : String(e)}`);
        return rawFrames.map((f) => f.filePath);
      });

      let frames = rawFrames.map((frame, i) => ({
        ...frame,
        filePath: optimizedPaths[i] ?? frame.filePath,
      }));

      // Dedup
      const beforeDedup = frames.length;
      frames = await deduplicateFrames(frames).catch(() => frames);
      if (frames.length < beforeDedup) {
        warnings.push(
          `Removed ${beforeDedup - frames.length} near-duplicate frames (${beforeDedup} → ${frames.length})`,
        );
      }

      await reportProgress({ progress: 75, total: 100 });

      // OCR
      const ocrResults = await extractTextFromFrames(frames).catch((e: unknown) => {
        warnings.push(`OCR failed: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      });

      await reportProgress({ progress: 90, total: 100 });

      // Build mini-timeline for this range
      const timeline = buildAnnotatedTimeline(transcriptSegment, frames, ocrResults);

      await reportProgress({ progress: 100, total: 100 });

      // Build response
      const textData = {
        range: { from, to, fromSeconds, toSeconds },
        transcriptSegment,
        frameCount: frames.length,
        ocrResults,
        timeline,
        warnings,
      };

      const content: ({ type: 'text'; text: string } | Awaited<ReturnType<typeof imageContent>>)[] =
        [{ type: 'text' as const, text: JSON.stringify(textData, null, 2) }];

      for (const frame of frames) {
        content.push(await imageContent({ path: frame.filePath }));
      }

      return { content };
    },
  });
}

/**
 * Loosely parse a transcript timestamp to seconds.
 * Returns null if parsing fails (instead of throwing).
 */
function parseTimestampLoose(ts: string): number | null {
  try {
    return parseTimestamp(ts);
  } catch {
    // Try parsing as plain number (seconds)
    const n = parseFloat(ts);
    return isNaN(n) ? null : n;
  }
}
