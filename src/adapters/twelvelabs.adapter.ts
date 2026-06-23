import type {
  IAdapterCapabilities,
  IChapter,
  ITranscriptEntry,
  IVideoComment,
  IVideoMetadata,
} from '../types.js';
import { detectPlatform } from '../utils/url-detector.js';
import { downloadDirectVideo, getFilenameFromUrl } from '../utils/video-download.js';
import type { IVideoAdapter } from './adapter.interface.js';

/**
 * TwelveLabs Pegasus adapter.
 *
 * Where the Loom and direct adapters hand a transcript (or nothing) to the
 * frame-processing pipeline, this adapter sends the video to TwelveLabs'
 * Pegasus video-language model for on-the-fly analysis and gets back an
 * AI-generated, timestamped transcript *and* a summary as text — the first
 * adapter to provide `aiSummary`. No frames, no Whisper key (Pegasus does its
 * own ASR). The transcript is best-effort LLM output: Pegasus is prompted to
 * emit `[MM:SS] line` rows, so its formatting/verbatimness depends on prompt
 * adherence rather than being a deterministic ASR dump.
 *
 * It is opt-in: it only handles direct video URLs, and only when
 * `TWELVELABS_API_KEY` is set. When the key is absent the DirectAdapter handles
 * the same URLs unchanged. Because these are public, direct video URLs, the
 * adapter registers them with TwelveLabs by URL (no upload).
 *
 * Failures (bad key, 5xx, asset/analyze `failed`, timeouts) propagate out of
 * `getTranscript`/`getAiSummary`/`getMetadata` so the tool layer records the
 * reason in `warnings[]` — they are not swallowed into empty results.
 *
 * Pure `fetch`/`FormData` (Node 18+) — no SDK dependency.
 */

const TL_API_BASE = 'https://api.twelvelabs.io/v1.3';
const TL_MODEL = 'pegasus1.5';
// One completion holds both the summary and the full transcript, so give it
// generous headroom. Very long videos can still exceed this; see the README.
const TL_MAX_TOKENS = 16_384;

const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_ASSET_READY_TIMEOUT_MS = 120_000;
const DEFAULT_ANALYZE_TIMEOUT_MS = 300_000;
// Per-request hard timeout. Without it, a single hung fetch would never settle
// and the wall-clock poll deadlines below (which only run *between* responses)
// could never fire.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const NO_DIALOGUE_SENTINEL = /^\(no spoken dialogue\)$/i;

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

/** Optional timing overrides — mainly so tests can exercise the poll/timeout branches without real sleeps. */
interface TwelveLabsAdapterOptions {
  pollIntervalMs?: number;
  assetReadyTimeoutMs?: number;
  analyzeTimeoutMs?: number;
  requestTimeoutMs?: number;
}

function tlApiKey(): string | undefined {
  const key = process.env.TWELVELABS_API_KEY;
  return key && key.trim() ? key.trim() : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function idOf(payload: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

/** Parse an "M:SS" / "MM:SS" / "H:MM:SS" timestamp into seconds (0 if unparseable). */
function timestampToSeconds(time: string): number {
  const parts = time.split(':').map((p) => Number.parseInt(p, 10));
  if (parts.length === 0 || parts.some((n) => Number.isNaN(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function extractText(result: unknown): string {
  if (typeof result === 'string') return result.trim();
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    for (const key of ['data', 'text', 'analysis', 'summary', 'generated_text', 'output']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    // An unrecognized object shape (e.g. a changed result schema) must NOT be
    // stringified into a fake summary — surface it as a failure instead.
    throw new Error(
      `TwelveLabs analyze result had no recognized text field; keys: ${Object.keys(record).join(', ')}`,
    );
  }
  throw new Error('TwelveLabs analyze result contained no text');
}

function parseTimestampedLines(text: string): ITranscriptEntry[] {
  const entries: ITranscriptEntry[] = [];
  const lineRe = /\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s*(.+)/;
  for (const raw of text.split('\n')) {
    const match = raw.match(lineRe);
    if (!match) continue;
    const lineText = match[4].trim();
    if (!lineText) continue;
    // The prompt asks Pegasus to emit "[00:00] (no spoken dialogue)" for silent
    // videos; treat that sentinel as an empty transcript, not a one-line one.
    if (NO_DIALOGUE_SENTINEL.test(lineText)) continue;
    const time =
      match[3] !== undefined
        ? `${Number.parseInt(match[1], 10)}:${match[2]}:${match[3]}`
        : `${Number.parseInt(match[1], 10)}:${match[2]}`;
    entries.push({ time, text: lineText });
  }
  return entries;
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

  private readonly pollIntervalMs: number;
  private readonly assetReadyTimeoutMs: number;
  private readonly analyzeTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  // One Pegasus analysis serves getMetadata + getTranscript + getAiSummary; cache
  // the in-flight promise per URL so concurrent calls share a single API round-trip.
  private readonly cache = new Map<string, Promise<AnalysisResult>>();

  constructor(options: TwelveLabsAdapterOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.assetReadyTimeoutMs = options.assetReadyTimeoutMs ?? DEFAULT_ASSET_READY_TIMEOUT_MS;
    this.analyzeTimeoutMs = options.analyzeTimeoutMs ?? DEFAULT_ANALYZE_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  canHandle(url: string): boolean {
    // Opt-in: only intercept direct video URLs, and only when a key is set, so
    // the DirectAdapter remains the default whenever TwelveLabs isn't configured.
    return Boolean(tlApiKey()) && detectPlatform(url) === 'direct';
  }

  async getMetadata(url: string): Promise<IVideoMetadata> {
    const metadata: IVideoMetadata = {
      platform: 'twelvelabs',
      title: getFilenameFromUrl(url),
      duration: 0,
      durationFormatted: '0:00',
      url,
    };
    // Pegasus returns no duration field, but the last transcript timestamp is a
    // lower bound — far better than asserting 0:00. Reuses the cached analysis,
    // so analyze_video still makes a single Pegasus call across all three getters.
    // Errors propagate; the tool layer records them in warnings[].
    const { transcript } = await this.analyze(url);
    const last = transcript[transcript.length - 1];
    if (last) {
      metadata.duration = timestampToSeconds(last.time);
      metadata.durationFormatted = last.time;
    }
    return metadata;
  }

  async getTranscript(url: string): Promise<ITranscriptEntry[]> {
    return (await this.analyze(url)).transcript;
  }

  async getComments(_url: string): Promise<IVideoComment[]> {
    return [];
  }

  async getChapters(_url: string): Promise<IChapter[]> {
    return [];
  }

  async getAiSummary(url: string): Promise<string | null> {
    const { summary } = await this.analyze(url);
    return summary || null;
  }

  async downloadVideo(url: string, destDir: string): Promise<string | null> {
    // Same direct HTTP download as DirectAdapter, so frame-based tools still
    // work alongside Pegasus analysis.
    return downloadDirectVideo(url, destDir);
  }

  private analyze(url: string): Promise<AnalysisResult> {
    const cached = this.cache.get(url);
    if (cached) return cached;
    const pending = this.runAnalysis(url);
    this.cache.set(url, pending);
    // De-dupe only the in-flight request: the three getters called together share
    // one round-trip, but the entry is evicted once it settles so later calls
    // re-analyze (no stale results, defers freshness to the caller).
    // `then(evict, evict)` (not `finally`) keeps this bookkeeping from surfacing
    // as an unhandled rejection — consumers await `pending` directly.
    const evict = (): void => {
      if (this.cache.get(url) === pending) this.cache.delete(url);
    };
    void pending.then(evict, evict);
    return pending;
  }

  private async runAnalysis(url: string): Promise<AnalysisResult> {
    const key = tlApiKey();
    if (!key) throw new Error('TWELVELABS_API_KEY is not set');
    const assetId = await this.registerUrlAsset(url, key);
    const text = await this.analyzeAsset(assetId, key);
    return parseAnalysis(text);
  }

  private async tlJson(
    path: string,
    key: string,
    init?: RequestInit,
  ): Promise<Record<string, unknown>> {
    // Hard per-request timeout via AbortController; clearTimeout in `finally` so
    // the timer never dangles once the request settles (e.g. under test).
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`request timed out after ${this.requestTimeoutMs}ms`)),
      this.requestTimeoutMs,
    );
    try {
      const response = await fetch(`${TL_API_BASE}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { 'x-api-key': key, ...(init?.headers ?? {}) },
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`TwelveLabs ${path} failed: HTTP ${response.status} ${body.slice(0, 300)}`);
      }
      return (await response.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Register a public direct-video URL as a TwelveLabs asset and wait until ready. */
  private async registerUrlAsset(url: string, key: string): Promise<string> {
    const form = new FormData();
    form.append('method', 'url');
    form.append('url', url);

    const created = await this.tlJson('/assets', key, { method: 'POST', body: form });
    const assetId = idOf(created, '_id', 'id', 'asset_id');
    if (!assetId) {
      throw new Error('TwelveLabs asset registration returned no id');
    }

    let status = String(created.status ?? '').toLowerCase();
    const deadline = Date.now() + this.assetReadyTimeoutMs;
    while (status !== 'ready') {
      if (status === 'failed') throw new Error(`TwelveLabs asset ${assetId} processing failed`);
      if (Date.now() > deadline) throw new Error(`TwelveLabs asset ${assetId} not ready in time`);
      await sleep(this.pollIntervalMs);
      const info = await this.tlJson(`/assets/${assetId}`, key);
      status = String(info.status ?? '').toLowerCase();
    }
    return assetId;
  }

  /** Run on-the-fly Pegasus analysis against an asset and return the generated text. */
  private async analyzeAsset(assetId: string, key: string): Promise<string> {
    const created = await this.tlJson('/analyze/tasks', key, {
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

    const deadline = Date.now() + this.analyzeTimeoutMs;
    for (;;) {
      const info = await this.tlJson(`/analyze/tasks/${taskId}`, key);
      const status = String(info.status ?? '').toLowerCase();
      if (status === 'ready') return extractText(info.result);
      if (status === 'failed') throw new Error(`TwelveLabs analyze task ${taskId} failed`);
      if (Date.now() > deadline) throw new Error(`TwelveLabs analyze task ${taskId} timed out`);
      await sleep(this.pollIntervalMs);
    }
  }
}
