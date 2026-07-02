import type { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { filterAnalysisResult } from '../utils/field-filter.js';
import type { AnalysisField } from '../utils/field-filter.js';
import { createProgressReporter } from '../utils/progress.js';
import { isVideoSource } from '../utils/url-detector.js';
import { AnalyzeOptionsSchema, getAnalysis, resolveAnalyzeParams } from './analyze-core.js';
import type { AnalyzeParams, ProgressReporter } from './analyze-core.js';

const AnalyzeVideosSchema = z.object({
  sources: z
    .array(
      z.string().refine(isVideoSource, {
        message:
          'Each source must be a supported video URL (Loom, YouTube, Vimeo, TikTok, Instagram, X/Twitter, Twitch, Dailymotion, Facebook), a direct .mp4/.webm/.mov URL, or an absolute path / file:// URI to a local video file',
      }),
    )
    .min(1)
    .max(500)
    .describe(
      'Video sources to analyze in one batch (Loom URLs, platform video URLs like YouTube, direct video URLs, or local paths).',
    ),
  options: AnalyzeOptionsSchema.describe('Analysis options applied to every source'),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(8)
    .optional()
    .describe(
      'How many videos to analyze in parallel (default: 2). Frame extraction + OCR are CPU-heavy — raise cautiously.',
    ),
});

/** Per-item batch outcome — a discriminated union on `ok`. */
type BatchItemResult =
  | {
      source: string;
      ok: true;
      title: string;
      duration: string;
      hasAudio?: boolean;
      frameCount: number;
      ocrCount: number;
      transcriptEntries: number;
      warnings: string[];
      /** Field-filtered analysis payload — only present when `options.fields` is set. */
      data?: ReturnType<typeof filterAnalysisResult>;
    }
  | { source: string; ok: false; error: string };

interface BatchSummary {
  total: number;
  ok: number;
  failed: number;
  concurrency: number;
}

const noopProgress: ProgressReporter = async () => undefined;

/**
 * Run `analyze_video`'s pipeline over many sources with a concurrency cap,
 * capturing a structured per-item result (one bad source never aborts the rest)
 * and cleaning up each item's temp dir as soon as its counts are captured (the
 * batch never inlines frame images, so there's nothing to keep alive). Exported
 * for testing.
 */
export async function runBatch(
  sources: string[],
  params: AnalyzeParams,
  fields: AnalysisField[] | undefined,
  concurrency: number,
  progress: ProgressReporter = noopProgress,
): Promise<{ summary: BatchSummary; results: BatchItemResult[] }> {
  const results = await mapWithConcurrency(
    sources,
    concurrency,
    async (source): Promise<BatchItemResult> => {
      try {
        const { result, cleanup } = await getAnalysis(source, params);
        try {
          return {
            source,
            ok: true,
            title: result.metadata.title,
            duration: result.metadata.durationFormatted,
            hasAudio: result.metadata.hasAudio,
            frameCount: result.frames.length,
            ocrCount: result.ocrResults.length,
            transcriptEntries: result.transcript.length,
            warnings: result.warnings,
            ...(fields ? { data: filterAnalysisResult(result, fields) } : {}),
          };
        } finally {
          await cleanup();
        }
      } catch (e: unknown) {
        return { source, ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    (completed, total) => {
      void progress(Math.round((completed / total) * 100), `Analyzed ${completed}/${total} videos`);
    },
  );

  const okCount = results.filter((r) => r.ok).length;
  return {
    summary: { total: results.length, ok: okCount, failed: results.length - okCount, concurrency },
    results,
  };
}

export function registerAnalyzeVideos(server: FastMCP): void {
  server.addTool({
    name: 'analyze_videos',
    description: `Batch-analyze many videos in one call, with a concurrency limit and per-item results.

For each source it runs the same pipeline as analyze_video (frames + OCR + transcript + timeline), reusing the shared cache and on-disk sidecars. Designed for processing a corpus of local files: pair it with MCP_WRITE_SIDECARS=1 so results persist next to each video and a re-run resumes instead of recomputing.

Returns a JSON summary plus one structured entry per source:
- ok=true → title, duration, frameCount, ocrCount, transcriptEntries, warnings
- ok=false → the error message for that specific video (other videos still complete)

To keep the response bounded, frame images are NOT inlined and full transcript/OCR/timeline arrays are returned only when options.fields is set; otherwise you get counts. Use analyze_video on an individual source when you need the images or full data inline.`,
    parameters: AnalyzeVideosSchema,
    annotations: {
      title: 'Analyze Videos (batch)',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    execute: async (args, { reportProgress }) => {
      const progress = createProgressReporter(reportProgress);
      const { sources, options } = args;
      const concurrency = args.concurrency ?? 2;
      const params = resolveAnalyzeParams(options);
      const fields = options?.fields as AnalysisField[] | undefined;

      await progress(0, `Analyzing ${sources.length} videos (concurrency ${concurrency})...`);

      const { summary, results } = await runBatch(sources, params, fields, concurrency, progress);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ summary, results }, null, 2) }],
      };
    },
  });
}
