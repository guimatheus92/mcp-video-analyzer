import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
  IAdapterCapabilities,
  IChapter,
  ITranscriptEntry,
  IVideoComment,
  IVideoMetadata,
} from '../types.js';
import { detectPlatform } from '../utils/url-detector.js';
import type { IVideoAdapter } from './adapter.interface.js';

/**
 * TwelveLabs Pegasus adapter.
 *
 * Where the Loom and direct adapters hand a transcript (or nothing) to the
 * frame-processing pipeline, this adapter sends the video to TwelveLabs'
 * Pegasus video-language model for on-the-fly analysis and gets back a
 * timestamped transcript *and* an AI summary as text — the first adapter to
 * provide `aiSummary`. No frames, no Whisper key (Pegasus does its own ASR).
 *
 * It is opt-in: it only handles direct video URLs, and only when
 * `TWELVELABS_API_KEY` is set. When the key is absent the DirectAdapter handles
 * the same URLs unchanged. Because these are public, direct video URLs, the
 * adapter registers them with TwelveLabs by URL (no upload).
 *
 * Pure `fetch`/`FormData` (Node 18+) — no SDK dependency.
 */

const TL_API_BASE = 'https://api.twelvelabs.io/v1.3';
const TL_MODEL = 'pegasus1.5';
const TL_MAX_TOKENS = 8192;
const POLL_INTERVAL_MS = 3000;
const ASSET_READY_TIMEOUT_MS = 120_000;
const ANALYZE_TIMEOUT_MS = 300_000;

const ANALYSIS_PROMPT = `Watch this video and respond in EXACTLY this format, with no text before "SUMMARY:":

SUMMARY:
<2-4 sentence summary of what the video shows and what is said>

TRANSCRIPT:
[MM:SS] <a verbatim line of the spoken dialogue or narration>
[MM:SS] <the next line>

Rules: exactly one transcript line per [MM:SS] timestamp, in chronological order, transcribing the audio verbatim. Use MM:SS (or HH:MM:SS for videos over an hour) relative to the start of the video. If there is no speech, output "[00:00] (no spoken dialogue)".`;

interface AnalysisResult {
  summary: string;
  transcript: ITranscriptEntry[];
}

function tlApiKey(): string | undefined {
  const key = process.env.TWELVELABS_API_KEY;
  return key && key.trim() ? key.trim() : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFilenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/');
    const lastSegment = segments[segments.length - 1];
    if (lastSegment && lastSegment.includes('.')) {
      return lastSegment;
    }
  } catch {
    // ignore parse errors
  }
  return 'video.mp4';
}

async function tlJson(
  path: string,
  key: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${TL_API_BASE}${path}`, {
    ...init,
    headers: { 'x-api-key': key, ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`TwelveLabs ${path} failed: HTTP ${response.status} ${body.slice(0, 300)}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

function idOf(payload: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

/** Register a public direct-video URL as a TwelveLabs asset and wait until ready. */
async function registerUrlAsset(url: string, key: string): Promise<string> {
  const form = new FormData();
  form.append('method', 'url');
  form.append('url', url);

  const created = await tlJson('/assets', key, { method: 'POST', body: form });
  const assetId = idOf(created, '_id', 'id', 'asset_id');
  if (!assetId) {
    throw new Error('TwelveLabs asset registration returned no id');
  }

  let status = String(created.status ?? '').toLowerCase();
  const deadline = Date.now() + ASSET_READY_TIMEOUT_MS;
  while (status !== 'ready') {
    if (status === 'failed') throw new Error(`TwelveLabs asset ${assetId} processing failed`);
    if (Date.now() > deadline) throw new Error(`TwelveLabs asset ${assetId} not ready in time`);
    await sleep(POLL_INTERVAL_MS);
    const info = await tlJson(`/assets/${assetId}`, key);
    status = String(info.status ?? '').toLowerCase();
  }
  return assetId;
}

/** Run on-the-fly Pegasus analysis against an asset and return the generated text. */
async function analyzeAsset(assetId: string, key: string): Promise<string> {
  const created = await tlJson('/analyze/tasks', key, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      video: { type: 'asset_id', asset_id: assetId },
      model_name: TL_MODEL,
      prompt: ANALYSIS_PROMPT,
      max_tokens: TL_MAX_TOKENS,
    }),
  });
  const taskId = idOf(created, 'task_id', '_id', 'id');
  if (!taskId) throw new Error('TwelveLabs analyze task returned no id');

  const deadline = Date.now() + ANALYZE_TIMEOUT_MS;
  for (;;) {
    const info = await tlJson(`/analyze/tasks/${taskId}`, key);
    const status = String(info.status ?? '').toLowerCase();
    if (status === 'ready') return extractText(info.result);
    if (status === 'failed') throw new Error(`TwelveLabs analyze task ${taskId} failed`);
    if (Date.now() > deadline) throw new Error(`TwelveLabs analyze task ${taskId} timed out`);
    await sleep(POLL_INTERVAL_MS);
  }
}

function extractText(result: unknown): string {
  if (typeof result === 'string') return result.trim();
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    for (const key of ['data', 'text', 'analysis', 'summary', 'generated_text', 'output']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return JSON.stringify(result);
  }
  return '';
}

function parseAnalysis(text: string): AnalysisResult {
  const marker = text.match(/TRANSCRIPT:/i);
  let summaryPart = text;
  let transcriptPart = '';
  if (marker?.index !== undefined) {
    summaryPart = text.slice(0, marker.index);
    transcriptPart = text.slice(marker.index + marker[0].length);
  }
  const summary = summaryPart.replace(/SUMMARY:/i, '').trim();
  return { summary, transcript: parseTimestampedLines(transcriptPart) };
}

function parseTimestampedLines(text: string): ITranscriptEntry[] {
  const entries: ITranscriptEntry[] = [];
  const lineRe = /\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s*(.+)/;
  for (const raw of text.split('\n')) {
    const match = raw.match(lineRe);
    if (!match) continue;
    const lineText = match[4].trim();
    if (!lineText) continue;
    const time =
      match[3] !== undefined
        ? `${parseInt(match[1], 10)}:${match[2]}:${match[3]}`
        : `${parseInt(match[1], 10)}:${match[2]}`;
    entries.push({ time, text: lineText });
  }
  return entries;
}

export class TwelveLabsAdapter implements IVideoAdapter {
  readonly name = 'twelvelabs';
  readonly capabilities: IAdapterCapabilities = {
    transcript: true,
    metadata: true,
    comments: false,
    chapters: false,
    aiSummary: true,
    videoDownload: true,
  };

  // One Pegasus analysis serves both getTranscript and getAiSummary; cache the
  // in-flight promise per URL so concurrent calls share a single API round-trip.
  private readonly cache = new Map<string, Promise<AnalysisResult>>();

  canHandle(url: string): boolean {
    // Opt-in: only intercept direct video URLs, and only when a key is set, so
    // the DirectAdapter remains the default whenever TwelveLabs isn't configured.
    return Boolean(tlApiKey()) && detectPlatform(url) === 'direct';
  }

  async getMetadata(url: string): Promise<IVideoMetadata> {
    const filename = getFilenameFromUrl(url);
    return {
      platform: 'twelvelabs',
      title: filename,
      duration: 0,
      durationFormatted: '0:00',
      url,
    };
  }

  async getTranscript(url: string): Promise<ITranscriptEntry[]> {
    try {
      return (await this.analyze(url)).transcript;
    } catch {
      return [];
    }
  }

  async getComments(_url: string): Promise<IVideoComment[]> {
    return [];
  }

  async getChapters(_url: string): Promise<IChapter[]> {
    return [];
  }

  async getAiSummary(url: string): Promise<string | null> {
    try {
      const { summary } = await this.analyze(url);
      return summary || null;
    } catch {
      return null;
    }
  }

  async downloadVideo(url: string, destDir: string): Promise<string | null> {
    // Same direct HTTP download as DirectAdapter, so frame-based tools still
    // work alongside Pegasus analysis.
    const destPath = join(destDir, getFilenameFromUrl(url));
    const response = await fetch(url);
    if (!response.ok || !response.body) return null;
    const nodeStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    await pipeline(nodeStream, createWriteStream(destPath));
    return destPath;
  }

  private analyze(url: string): Promise<AnalysisResult> {
    const cached = this.cache.get(url);
    if (cached) return cached;
    const pending = this.runAnalysis(url);
    this.cache.set(url, pending);
    // De-dupe only the in-flight request: getTranscript + getAiSummary called
    // together share one round-trip, but the entry is evicted once it settles so
    // later calls re-analyze (no stale results, defers freshness to the caller).
    void pending.finally(() => {
      if (this.cache.get(url) === pending) this.cache.delete(url);
    });
    return pending;
  }

  private async runAnalysis(url: string): Promise<AnalysisResult> {
    const key = tlApiKey();
    if (!key) throw new Error('TWELVELABS_API_KEY is not set');
    const assetId = await registerUrlAsset(url, key);
    const text = await analyzeAsset(assetId, key);
    return parseAnalysis(text);
  }
}
