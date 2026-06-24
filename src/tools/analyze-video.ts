import type { FastMCP } from 'fastmcp';
import { z } from 'zod';
import type { AnalysisField } from '../utils/field-filter.js';
import { createProgressReporter } from '../utils/progress.js';
import { isVideoSource } from '../utils/url-detector.js';
import {
  AnalyzeOptionsSchema,
  buildAnalysisContent,
  getAnalysis,
  resolveAnalyzeParams,
} from './analyze-core.js';

const AnalyzeVideoSchema = z.object({
  url: z
    .string()
    .refine(isVideoSource, {
      message:
        'Must be a Loom share URL, a direct .mp4/.webm/.mov URL, or an absolute path / file:// URI to a local video file',
    })
    .describe(
      'Video source: Loom share link, direct .mp4/.webm/.mov URL, or absolute path to a local video file',
    ),
  options: AnalyzeOptionsSchema.describe('Analysis options'),
});

export function registerAnalyzeVideo(server: FastMCP): void {
  server.addTool({
    name: 'analyze_video',
    description: `Analyze a video URL to extract transcript, key frames, metadata, comments, OCR text, and annotated timeline.

Returns structured data about the video content:
- Transcript with timestamps and speakers
- Key frames extracted via scene-change detection (deduplicated, as images). For static clips with no scene cuts (e.g. talking-head Reels/Stories where only on-screen text changes) it automatically falls back to uniform temporal sampling.
- OCR text extracted from frames (code, error messages, UI text, prices/dates/CTAs visible on screen)
- Annotated timeline merging transcript + frames + OCR into a unified chronological view
- Metadata (title, duration, platform)
- Comments from viewers (if available)

Supports: Loom (loom.com/share/...), direct video URLs (.mp4, .webm, .mov), and local video files (absolute path or file:// URI).

Detail levels:
- "brief": metadata + truncated transcript only (fast, no video download)
- "standard": full analysis with scene-change frames (default)
- "detailed": dense sampling (1 frame/sec), more frames, full OCR

Use options.fields to request only specific data (e.g., ["metadata", "transcript"]).
Use options.forceRefresh to bypass the cache.
Use options.model / options.language / options.initialPrompt to override Whisper transcription per call (e.g. a heavier model + a domain glossary for hard audio) without restarting the server.`,
    parameters: AnalyzeVideoSchema,
    annotations: {
      title: 'Analyze Video',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    execute: async (args, { reportProgress }) => {
      const progress = createProgressReporter(reportProgress);
      const { url, options } = args;
      const params = resolveAnalyzeParams(options);
      const fields = options?.fields as AnalysisField[] | undefined;

      // Single-video path keeps the frame temp dir alive so a cache hit within
      // the TTL can still re-serve images; cleanup happens on process exit /
      // cache eviction. (The batch tool, which never inlines images, cleans up
      // per item.)
      const { result } = await getAnalysis(url, params, progress);

      return { content: await buildAnalysisContent(result, fields) };
    },
  });
}
