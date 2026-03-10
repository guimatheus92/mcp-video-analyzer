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
import { extractTextFromFrames } from '../processors/frame-ocr.js';
import { buildAnnotatedTimeline } from '../processors/annotated-timeline.js';
import { optimizeFrames } from '../processors/image-optimizer.js';
import { extractAudioTrack, transcribeAudio } from '../processors/audio-transcriber.js';
import { createTempDir, cleanupTempDir } from '../utils/temp-files.js';
import { AnalysisCache, cacheKey } from '../utils/cache.js';
import { getDetailConfig } from '../config/detail-levels.js';
import { filterAnalysisResult } from '../utils/field-filter.js';
import type { AnalysisField } from '../utils/field-filter.js';
import type { IAnalysisResult } from '../types.js';

const cache = new AnalysisCache();

const ANALYSIS_FIELDS = [
  'metadata',
  'transcript',
  'frames',
  'comments',
  'chapters',
  'ocrResults',
  'timeline',
  'aiSummary',
] as const;

const AnalyzeOptionsSchema = z
  .object({
    maxFrames: z
      .number()
      .min(1)
      .max(60)
      .optional()
      .describe('Maximum number of key frames to extract (default depends on detail level)'),
    threshold: z
      .number()
      .min(0)
      .max(1)
      .default(0.1)
      .optional()
      .describe(
        'Scene-change sensitivity 0.0-1.0 (lower = more frames, default: 0.1). Use 0.1 for screencasts/demos, 0.3 for live-action video.',
      ),
    returnBase64: z
      .boolean()
      .default(false)
      .optional()
      .describe('Return frames as base64 inline instead of file paths'),
    skipFrames: z
      .boolean()
      .default(false)
      .optional()
      .describe('Skip frame extraction (transcript + metadata only)'),
    detail: z
      .enum(['brief', 'standard', 'detailed'])
      .default('standard')
      .optional()
      .describe(
        'Analysis depth: "brief" (metadata + truncated transcript, no frames), "standard" (default), "detailed" (dense sampling, more frames)',
      ),
    fields: z
      .array(z.enum(ANALYSIS_FIELDS))
      .optional()
      .describe(
        'Specific fields to return (default: all). E.g., ["metadata", "transcript"] returns only those fields.',
      ),
    forceRefresh: z
      .boolean()
      .default(false)
      .optional()
      .describe('Bypass cache and re-analyze the video'),
  })
  .optional();

const AnalyzeVideoSchema = z.object({
  url: z.string().url().describe('Video URL (Loom share link or direct mp4/webm URL)'),
  options: AnalyzeOptionsSchema.describe('Analysis options'),
});

export function registerAnalyzeVideo(server: FastMCP): void {
  server.addTool({
    name: 'analyze_video',
    description: `Analyze a video URL to extract transcript, key frames, metadata, comments, OCR text, and annotated timeline.

Returns structured data about the video content:
- Transcript with timestamps and speakers
- Key frames extracted via scene-change detection (deduplicated, as images)
- OCR text extracted from frames (code, error messages, UI text visible on screen)
- Annotated timeline merging transcript + frames + OCR into a unified chronological view
- Metadata (title, duration, platform)
- Comments from viewers (if available)

Supports: Loom (loom.com/share/...) and direct video URLs (.mp4, .webm, .mov).

Detail levels:
- "brief": metadata + truncated transcript only (fast, no video download)
- "standard": full analysis with scene-change frames (default)
- "detailed": dense sampling (1 frame/sec), more frames, full OCR

Use options.fields to request only specific data (e.g., ["metadata", "transcript"]).
Use options.forceRefresh to bypass the cache.`,
    parameters: AnalyzeVideoSchema,
    annotations: {
      title: 'Analyze Video',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    execute: async (args, { reportProgress }) => {
      const { url, options } = args;
      const detail = options?.detail ?? 'standard';
      const forceRefresh = options?.forceRefresh ?? false;
      const fields = options?.fields as AnalysisField[] | undefined;
      const threshold = options?.threshold ?? 0.1;

      // Resolve detail config
      const config = getDetailConfig(detail);
      const maxFrames = options?.maxFrames ?? config.maxFrames;
      const skipFrames = options?.skipFrames ?? !config.includeFrames;

      // Cache check
      const key = cacheKey(url, { detail, maxFrames, threshold });
      if (!forceRefresh) {
        const cached = cache.get(key);
        if (cached) {
          const filtered = filterAnalysisResult(cached, fields);
          const textData = { ...filtered, frameCount: cached.frames.length };
          const content: (
            | { type: 'text'; text: string }
            | Awaited<ReturnType<typeof imageContent>>
          )[] = [{ type: 'text' as const, text: JSON.stringify(textData, null, 2) }];

          // Re-add frame images if included
          if (!fields || fields.includes('frames')) {
            for (const frame of cached.frames) {
              try {
                content.push(await imageContent({ path: frame.filePath }));
              } catch {
                // Frame file may have been cleaned up
              }
            }
          }

          return { content };
        }
      }

      let adapter;
      try {
        adapter = getAdapter(url);
      } catch (error) {
        if (error instanceof UserError) throw error;
        throw new UserError(`Failed to detect video platform for URL: ${url}`);
      }

      const warnings: string[] = [];
      let tempDir: string | null = null;

      try {
        await reportProgress({ progress: 0, total: 100 });

        // Fetch metadata, transcript, comments in parallel
        const [metadata, transcript, comments, chapters, aiSummary] = await Promise.all([
          adapter.getMetadata(url).catch((e: unknown) => {
            warnings.push(
              `Failed to fetch metadata: ${e instanceof Error ? e.message : String(e)}`,
            );
            return {
              platform: adapter.name as 'loom' | 'direct' | 'unknown',
              title: 'Unknown',
              duration: 0,
              durationFormatted: '0:00',
              url,
            };
          }),
          adapter.getTranscript(url).catch((e: unknown) => {
            warnings.push(
              `Failed to fetch transcript: ${e instanceof Error ? e.message : String(e)}`,
            );
            return [];
          }),
          adapter.getComments(url).catch((e: unknown) => {
            warnings.push(
              `Failed to fetch comments: ${e instanceof Error ? e.message : String(e)}`,
            );
            return [];
          }),
          adapter.getChapters(url).catch(() => []),
          adapter.getAiSummary(url).catch(() => null),
        ]);

        await reportProgress({ progress: 40, total: 100 });

        // Apply transcript limit for brief mode
        const limitedTranscript =
          config.transcriptMaxEntries !== null
            ? transcript.slice(0, config.transcriptMaxEntries)
            : transcript;

        // Frame extraction (if not skipped)
        const result: IAnalysisResult = {
          metadata,
          transcript: limitedTranscript,
          frames: [],
          comments,
          chapters,
          ocrResults: [],
          timeline: [],
          aiSummary: aiSummary ?? undefined,
          warnings,
        };

        let videoPath: string | null = null;

        if (!skipFrames) {
          tempDir = await createTempDir();
          let framesExtracted = false;

          // Strategy 1: yt-dlp download + ffmpeg frame extraction
          if (adapter.capabilities.videoDownload) {
            videoPath = await adapter.downloadVideo(url, tempDir);

            if (videoPath) {
              await reportProgress({ progress: 60, total: 100 });

              // Probe duration if metadata didn't provide it
              if (metadata.duration === 0) {
                const duration = await probeVideoDuration(videoPath).catch(() => 0);
                metadata.duration = duration;
                metadata.durationFormatted = formatTimestamp(Math.floor(duration));
              }

              // Extract frames: dense or scene-based
              const rawFrames = config.denseSampling
                ? await extractDenseFrames(videoPath, tempDir, { maxFrames }).catch(
                    (e: unknown) => {
                      warnings.push(
                        `Dense frame extraction failed: ${e instanceof Error ? e.message : String(e)}`,
                      );
                      return [];
                    },
                  )
                : await extractSceneFrames(videoPath, tempDir, {
                    threshold,
                    maxFrames,
                  }).catch((e: unknown) => {
                    warnings.push(
                      `Frame extraction failed: ${e instanceof Error ? e.message : String(e)}`,
                    );
                    return [];
                  });

              await reportProgress({ progress: 80, total: 100 });

              if (rawFrames.length > 0) {
                const optimizedPaths = await optimizeFrames(
                  rawFrames.map((f) => f.filePath),
                  tempDir,
                ).catch((e: unknown) => {
                  warnings.push(
                    `Frame optimization failed: ${e instanceof Error ? e.message : String(e)}`,
                  );
                  return rawFrames.map((f) => f.filePath);
                });

                result.frames = rawFrames.map((frame, i) => ({
                  ...frame,
                  filePath: optimizedPaths[i] ?? frame.filePath,
                }));
                framesExtracted = true;
              }
            }
          }

          // Strategy 2: Browser-based extraction (fallback)
          if (!framesExtracted && metadata.duration > 0) {
            await reportProgress({ progress: 60, total: 100 });

            const timestamps = generateTimestamps(metadata.duration, maxFrames);
            const browserFrames = await extractBrowserFrames(url, tempDir, {
              timestamps,
            }).catch((e: unknown) => {
              warnings.push(
                `Browser frame extraction failed: ${e instanceof Error ? e.message : String(e)}`,
              );
              return [];
            });

            await reportProgress({ progress: 80, total: 100 });

            if (browserFrames.length > 0) {
              result.frames = browserFrames;
              framesExtracted = true;
            }
          }

          if (!framesExtracted) {
            warnings.push(
              'Frame extraction not available — returning transcript and metadata only. Install yt-dlp or Chrome/Chromium for frame extraction.',
            );
          }

          // Post-processing: dedup, OCR, timeline
          if (result.frames.length > 0) {
            const beforeDedup = result.frames.length;
            result.frames = await deduplicateFrames(result.frames).catch((e: unknown) => {
              warnings.push(`Frame dedup failed: ${e instanceof Error ? e.message : String(e)}`);
              return result.frames;
            });
            if (result.frames.length < beforeDedup) {
              warnings.push(
                `Removed ${beforeDedup - result.frames.length} near-duplicate frames (${beforeDedup} → ${result.frames.length})`,
              );
            }

            await reportProgress({ progress: 85, total: 100 });

            // OCR: extract text visible on screen
            if (config.includeOcr) {
              result.ocrResults = await extractTextFromFrames(result.frames).catch((e: unknown) => {
                warnings.push(`OCR failed: ${e instanceof Error ? e.message : String(e)}`);
                return [];
              });
            }

            await reportProgress({ progress: 95, total: 100 });
          }

          // Build annotated timeline
          if (config.includeTimeline) {
            result.timeline = buildAnnotatedTimeline(
              result.transcript,
              result.frames,
              result.ocrResults,
            );
          }
        } else {
          // Even without frames, try to get the video for whisper fallback
          if (result.transcript.length === 0 && adapter.capabilities.videoDownload) {
            tempDir = tempDir ?? (await createTempDir());
            videoPath = await adapter.downloadVideo(url, tempDir).catch(() => null);
          }
        }

        // Whisper fallback: if no transcript and we have a video file
        if (result.transcript.length === 0 && videoPath) {
          try {
            const audioPath = await extractAudioTrack(videoPath, tempDir ?? '');
            const whisperTranscript = await transcribeAudio(audioPath);
            if (whisperTranscript.length > 0) {
              result.transcript = whisperTranscript;
              warnings.push(
                'Transcript generated via Whisper fallback (no native transcript available).',
              );
            }
          } catch {
            // Audio extraction or transcription failed — not critical
          }
        }

        await reportProgress({ progress: 100, total: 100 });

        // Cache the full result
        cache.set(key, result);

        // Apply field filter
        const filtered = filterAnalysisResult(result, fields);

        // Build response content
        const textData = {
          ...filtered,
          frameCount: result.frames.length,
        };

        const content: (
          | { type: 'text'; text: string }
          | Awaited<ReturnType<typeof imageContent>>
        )[] = [{ type: 'text' as const, text: JSON.stringify(textData, null, 2) }];

        // Add frame images (if not filtered out)
        if (!fields || fields.includes('frames')) {
          for (const frame of result.frames) {
            content.push(await imageContent({ path: frame.filePath }));
          }
        }

        return { content };
      } finally {
        if (tempDir && skipFrames) {
          await cleanupTempDir(tempDir).catch(() => undefined);
        }
      }
    },
  });
}
