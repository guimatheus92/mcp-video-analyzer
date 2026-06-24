import { imageContent } from 'fastmcp';
import { z } from 'zod';
import { getAdapter } from '../adapters/adapter.interface.js';
import { getDetailConfig } from '../config/detail-levels.js';
import type { DetailLevel } from '../config/detail-levels.js';
import { buildAnnotatedTimeline } from '../processors/annotated-timeline.js';
import { extractAudioTrack, transcribeAudio } from '../processors/audio-transcriber.js';
import type { TranscribeOptions } from '../processors/audio-transcriber.js';
import { extractBrowserFrames, generateTimestamps } from '../processors/browser-frame-extractor.js';
import {
  dedupeKeepingTextChanges,
  deduplicateFrames,
  filterBlackFrames,
} from '../processors/frame-dedup.js';
import {
  extractKeyFrames,
  formatTimestamp,
  probeVideoDuration,
} from '../processors/frame-extractor.js';
import { isMeaningfulOcr, ocrFrames } from '../processors/frame-ocr.js';
import type { IOcrResult } from '../processors/frame-ocr.js';
import { optimizeFrames } from '../processors/image-optimizer.js';
import type { IAnalysisResult, IVideoMetadata } from '../types.js';
import { readAnalysisSidecar, writeAnalysisSidecars } from '../utils/analysis-sidecar.js';
import { AnalysisCache, cacheKey } from '../utils/cache.js';
import { filterAnalysisResult } from '../utils/field-filter.js';
import type { AnalysisField } from '../utils/field-filter.js';
import { cleanupTempDir, createTempDir } from '../utils/temp-files.js';
import { toLocalPath } from '../utils/url-detector.js';

/** Shared analysis cache (used by both analyze_video and analyze_videos). */
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

/** Reusable zod schema for the per-call analysis options (single + batch). */
export const AnalyzeOptionsSchema = z
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
    ocrLanguage: z
      .string()
      .optional()
      .describe(
        'Tesseract OCR language codes (default: "eng+por"). Use "+" to combine: "eng+spa", "eng+fra+deu". See Tesseract docs for codes.',
      ),
    model: z
      .string()
      .optional()
      .describe(
        'Whisper model for transcription fallback (overrides WHISPER_MODEL for this call), e.g. "small", "medium".',
      ),
    language: z
      .string()
      .optional()
      .describe('Forced transcription language code (overrides WHISPER_LANGUAGE), e.g. "pt".'),
    initialPrompt: z
      .string()
      .optional()
      .describe(
        'Domain glossary fed to Whisper as --initial_prompt (overrides WHISPER_PROMPT). Fixes proper nouns (brand/place names) in the transcript.',
      ),
  })
  .optional();

export type AnalyzeOptions = z.infer<typeof AnalyzeOptionsSchema>;

/** Fully-resolved analysis parameters (defaults applied). */
export interface AnalyzeParams {
  detail: DetailLevel;
  maxFrames: number;
  threshold: number;
  skipFrames: boolean;
  ocrLanguage: string;
  forceRefresh: boolean;
  transcribe: TranscribeOptions;
}

/** Resolve raw tool options into concrete params with all defaults applied. */
export function resolveAnalyzeParams(options: AnalyzeOptions): AnalyzeParams {
  const detail = options?.detail ?? 'standard';
  const config = getDetailConfig(detail);
  return {
    detail,
    maxFrames: options?.maxFrames ?? config.maxFrames,
    threshold: options?.threshold ?? 0.1,
    skipFrames: options?.skipFrames ?? !config.includeFrames,
    ocrLanguage: options?.ocrLanguage ?? 'eng+por',
    forceRefresh: options?.forceRefresh ?? false,
    transcribe: {
      model: options?.model,
      language: options?.language,
      initialPrompt: options?.initialPrompt,
    },
  };
}

/** Params that affect the result — used for both cache key and sidecar validity. */
function resultDefiningParams(params: AnalyzeParams): Record<string, unknown> {
  return {
    detail: params.detail,
    maxFrames: params.maxFrames,
    threshold: params.threshold,
    ocrLanguage: params.ocrLanguage,
    model: params.transcribe.model,
    language: params.transcribe.language,
    initialPrompt: params.transcribe.initialPrompt,
  };
}

export type ProgressReporter = (progress: number, message?: string) => Promise<void>;

const noopProgress: ProgressReporter = async () => undefined;

/**
 * Run the full analysis pipeline for one source. Returns the result plus whether
 * the transcript was produced by the Whisper fallback (so callers can decide
 * whether to persist it as a sidecar). Never throws for partial failures —
 * everything degrades into `result.warnings`.
 */
async function runAnalysisPipeline(
  url: string,
  params: AnalyzeParams,
  progress: ProgressReporter,
): Promise<{ result: IAnalysisResult; transcriptFromWhisper: boolean }> {
  const adapter = getAdapter(url);
  const config = getDetailConfig(params.detail);
  const { maxFrames, threshold, skipFrames, ocrLanguage } = params;

  const warnings: string[] = [];
  let tempDir: string | null = null;
  let transcriptFromWhisper = false;

  try {
    await progress(0, 'Starting video analysis...');

    const [metadata, transcript, comments, chapters, aiSummary] = await Promise.all([
      adapter.getMetadata(url).catch((e: unknown): IVideoMetadata => {
        warnings.push(`Failed to fetch metadata: ${e instanceof Error ? e.message : String(e)}`);
        return {
          platform: adapter.name,
          title: 'Unknown',
          duration: 0,
          durationFormatted: '0:00',
          url,
        };
      }),
      adapter.getTranscript(url).catch((e: unknown) => {
        warnings.push(`Failed to fetch transcript: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      }),
      adapter.getComments(url).catch((e: unknown) => {
        warnings.push(`Failed to fetch comments: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      }),
      adapter.getChapters(url).catch(() => []),
      adapter.getAiSummary(url).catch((e: unknown) => {
        warnings.push(`Failed to fetch AI summary: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }),
    ]);

    await progress(35, 'Metadata and transcript fetched');

    const limitedTranscript =
      config.transcriptMaxEntries !== null
        ? transcript.slice(0, config.transcriptMaxEntries)
        : transcript;

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

    const isLocal = toLocalPath(url) !== null;
    let videoPath: string | null = null;

    if (!skipFrames) {
      tempDir = await createTempDir();
      let framesExtracted = false;

      // Strategy 1: download (no-op for local files) + ffmpeg frame extraction
      // with scene→uniform-sampling fallback for static clips.
      if (adapter.capabilities.videoDownload) {
        videoPath = await adapter.downloadVideo(url, tempDir);

        if (videoPath) {
          await progress(50, 'Video downloaded, extracting frames...');

          if (metadata.duration === 0) {
            const duration = await probeVideoDuration(videoPath).catch(() => 0);
            metadata.duration = duration;
            metadata.durationFormatted = formatTimestamp(Math.floor(duration));
          }

          const extraction = await extractKeyFrames(videoPath, tempDir, {
            threshold,
            maxFrames,
            dense: config.denseSampling,
          });
          warnings.push(...extraction.warnings);
          const rawFrames = extraction.frames;

          await progress(70, `Extracted ${rawFrames.length} frames, optimizing...`);

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

      // Strategy 2: browser fallback — skipped for local files (puppeteer.goto()
      // can't load fs paths reliably; the ffmpeg path above always handles them).
      if (!framesExtracted && !isLocal && metadata.duration > 0) {
        await progress(50, 'Extracting frames via browser fallback...');

        const timestamps = generateTimestamps(metadata.duration, maxFrames);
        const browserFrames = await extractBrowserFrames(url, tempDir, { timestamps }).catch(
          (e: unknown) => {
            warnings.push(
              `Browser frame extraction failed: ${e instanceof Error ? e.message : String(e)}`,
            );
            return [];
          },
        );

        await progress(70, `Browser extracted ${browserFrames.length} frames`);

        if (browserFrames.length > 0) {
          result.frames = browserFrames;
          framesExtracted = true;
        }
      }

      if (!framesExtracted) {
        warnings.push(
          isLocal
            ? 'Could not extract frames from this local file — ffmpeg produced no frames (the file may be unreadable, zero-length, or have no decodable video stream).'
            : 'Frame extraction not available — returning transcript and metadata only. Install yt-dlp or Chrome/Chromium for frame extraction.',
        );
      }

      if (result.frames.length > 0) {
        const blackResult = await filterBlackFrames(result.frames).catch(() => ({
          frames: result.frames,
          removedCount: 0,
        }));
        if (blackResult.removedCount > 0) {
          warnings.push(
            `Removed ${blackResult.removedCount} black/blank frame(s) — video may be DRM-protected`,
          );
        }
        result.frames = blackResult.frames;
      }

      if (result.frames.length > 0) {
        const beforeDedup = result.frames.length;

        if (config.includeOcr) {
          // OCR every frame BEFORE dedup so frames that differ only by their
          // on-screen text (static-background Reels/Stories) survive instead of
          // being collapsed by a coarse perceptual hash.
          await progress(82, `Running OCR on ${result.frames.length} frames...`);
          const perFrame = await ocrFrames(result.frames, ocrLanguage, (completed, total) => {
            const pct = 82 + Math.round((completed / total) * 9);
            progress(pct, `OCR: processing frame ${completed}/${total}...`);
          }).catch((e: unknown): IOcrResult[] => {
            warnings.push(`OCR failed: ${e instanceof Error ? e.message : String(e)}`);
            return [];
          });

          if (perFrame.length === result.frames.length) {
            // Only confident text drives the text-aware dedup; low-confidence
            // noise is treated as "no text" so it can't fake a change.
            const texts = perFrame.map((r) => (isMeaningfulOcr(r) ? r.text : ''));
            const keep = await dedupeKeepingTextChanges(result.frames, texts).catch(() => null);
            if (keep) {
              const framesBefore = result.frames;
              result.frames = keep.map((i) => framesBefore[i]);
              result.ocrResults = keep.map((i) => perFrame[i]).filter(isMeaningfulOcr);
            } else {
              result.ocrResults = perFrame.filter(isMeaningfulOcr);
            }
          } else {
            // OCR unavailable or misaligned — fall back to visual-only dedup.
            result.frames = await deduplicateFrames(result.frames).catch(() => result.frames);
          }
        } else {
          result.frames = await deduplicateFrames(result.frames).catch((e: unknown) => {
            warnings.push(`Frame dedup failed: ${e instanceof Error ? e.message : String(e)}`);
            return result.frames;
          });
        }

        if (result.frames.length < beforeDedup) {
          warnings.push(
            `Removed ${beforeDedup - result.frames.length} near-duplicate frame(s) (${beforeDedup} → ${result.frames.length})`,
          );
        }

        await progress(93, 'Frames deduplicated and OCR complete');
      }

      if (config.includeTimeline) {
        await progress(95, 'Building annotated timeline...');
        result.timeline = buildAnnotatedTimeline(
          result.transcript,
          result.frames,
          result.ocrResults,
        );
      }
    } else if (result.transcript.length === 0 && adapter.capabilities.videoDownload) {
      // Even without frames, fetch the video so the Whisper fallback can run.
      tempDir = tempDir ?? (await createTempDir());
      videoPath = await adapter.downloadVideo(url, tempDir).catch(() => null);
    }

    // Whisper fallback: no transcript + a video file + a (probable) audio track.
    if (result.transcript.length === 0 && videoPath && metadata.hasAudio !== false) {
      try {
        const audioPath = await extractAudioTrack(videoPath, tempDir ?? '');
        const whisperTranscript = await transcribeAudio(audioPath, params.transcribe);
        if (whisperTranscript.length > 0) {
          result.transcript = whisperTranscript;
          transcriptFromWhisper = true;
          warnings.push(
            'Transcript generated via Whisper fallback (no native transcript available).',
          );
        }
      } catch (e: unknown) {
        warnings.push(`Whisper fallback failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (result.transcript.length === 0) {
      warnings.push(
        metadata.hasAudio === false
          ? 'No audio track in this clip — nothing to transcribe.'
          : 'No transcript available for this video.',
      );
    }

    await progress(100, 'Analysis complete');

    return { result, transcriptFromWhisper };
  } finally {
    // Frames live in tempDir and must survive for imageContent; only clean up
    // when no frames were requested (matches the original lifecycle).
    if (tempDir && skipFrames) {
      await cleanupTempDir(tempDir).catch(() => undefined);
    }
  }
}

/**
 * Cache- and sidecar-aware analysis entry point. Checks the in-memory cache, then
 * an on-disk `.analysis.json` sidecar, before running the full pipeline. On a
 * fresh run it populates the cache and (when MCP_WRITE_SIDECARS=1) writes
 * sidecars next to the source.
 */
export async function getAnalysis(
  url: string,
  params: AnalyzeParams,
  progress: ProgressReporter = noopProgress,
): Promise<IAnalysisResult> {
  const keyParams = resultDefiningParams(params);
  const key = cacheKey(url, keyParams);

  if (!params.forceRefresh) {
    const cached = cache.get(key);
    if (cached) return cached;

    const fromDisk = await readAnalysisSidecar(url, keyParams);
    if (fromDisk) {
      cache.set(key, fromDisk);
      return fromDisk;
    }
  }

  const { result, transcriptFromWhisper } = await runAnalysisPipeline(url, params, progress);
  cache.set(key, result);

  const written = await writeAnalysisSidecars(url, result, keyParams, { transcriptFromWhisper });
  if (written.length > 0) {
    result.warnings.push(
      `Persisted ${written.length} sidecar artifact(s) next to the video (MCP_WRITE_SIDECARS) for resumable reuse.`,
    );
  }

  return result;
}

export type ToolContent = { type: 'text'; text: string } | Awaited<ReturnType<typeof imageContent>>;

/**
 * Build the MCP tool response content for an analysis result: a JSON text block
 * (field-filtered) followed by the frame images (unless `frames` is filtered
 * out). Missing frame files are skipped silently — they may be temp files that
 * were cleaned up, or sidecar frames that were deleted.
 */
export async function buildAnalysisContent(
  result: IAnalysisResult,
  fields: AnalysisField[] | undefined,
): Promise<ToolContent[]> {
  const filtered = filterAnalysisResult(result, fields);
  const textData = { ...filtered, frameCount: result.frames.length };

  const content: ToolContent[] = [{ type: 'text', text: JSON.stringify(textData, null, 2) }];

  if (!fields || fields.includes('frames')) {
    for (const frame of result.frames) {
      try {
        content.push(await imageContent({ path: frame.filePath }));
      } catch {
        // Frame file may have been cleaned up — skip it.
      }
    }
  }

  return content;
}
