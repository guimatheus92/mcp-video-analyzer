import { existsSync, statSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clearAdapters,
  getAdapter,
  registerAdapter,
} from '../../src/adapters/adapter.interface.js';
import { LoomAdapter } from '../../src/adapters/loom.adapter.js';
import { getAnalysis, resolveAnalyzeParams } from '../../src/tools/analyze-core.js';
import { cleanupTempDir, createTempDir } from '../../src/utils/temp-files.js';
import { TEST_LOOM_URL, isVideoUnavailable } from './fixtures.js';

describe('E2E: Loom video analysis', () => {
  beforeAll(() => {
    clearAdapters();
    registerAdapter(new LoomAdapter());
  });

  afterAll(() => {
    clearAdapters();
  });

  it('detects loom adapter for Loom URL', () => {
    const adapter = getAdapter(TEST_LOOM_URL);
    expect(adapter.name).toBe('loom');
  });

  it('fetches metadata with title and duration', async () => {
    const adapter = getAdapter(TEST_LOOM_URL);
    const metadata = await adapter.getMetadata(TEST_LOOM_URL);

    expect(metadata.platform).toBe('loom');
    expect(metadata.title).toBeTruthy();
    expect(metadata.duration).toBeGreaterThan(0);
    expect(metadata.durationFormatted).toMatch(/^\d+:\d{2}/);
    expect(metadata.url).toBe(TEST_LOOM_URL);
  });

  it('fetches transcript entries', async () => {
    const adapter = getAdapter(TEST_LOOM_URL);
    const transcript = await adapter.getTranscript(TEST_LOOM_URL);

    expect(Array.isArray(transcript)).toBe(true);
    // Most Loom videos have transcripts, but some may not
    if (transcript.length > 0) {
      expect(transcript[0]).toHaveProperty('time');
      expect(transcript[0]).toHaveProperty('text');
      expect(transcript[0].text.length).toBeGreaterThan(0);
    }
  });

  it('fetches comments array', async () => {
    const adapter = getAdapter(TEST_LOOM_URL);
    const comments = await adapter.getComments(TEST_LOOM_URL);

    expect(Array.isArray(comments)).toBe(true);
    // Comments may be empty, but should not throw
  });

  // Issue #24. This block replaces a test that asserted `downloadVideo` returns
  // null and called it "(no auth)" — Loom public videos need no auth, so it
  // passed both when the code worked and when it was broken. It could never
  // fail, and it is the reason a 44MB download being silently discarded went
  // unnoticed. Assert the real outcome instead.
  describe('video download and frames', () => {
    let tempDir: string;

    beforeAll(async () => {
      tempDir = await createTempDir('e2e-loom-');
    });

    afterAll(async () => {
      if (tempDir) await cleanupTempDir(tempDir);
    });

    it('downloads a playable file, whatever container Loom serves', async (ctx) => {
      const adapter = getAdapter(TEST_LOOM_URL);
      const warnings: string[] = [];
      const videoPath = await adapter.downloadVideo(TEST_LOOM_URL, tempDir, (w) =>
        warnings.push(w),
      );

      if (videoPath === null) {
        // Only a *positive* "the video is gone" signal excuses this.
        if (isVideoUnavailable(warnings.join(' '))) {
          ctx.skip(`TEST_LOOM_URL is unavailable: ${warnings.join(' ')}`);
        }
        throw new Error(
          `Loom download returned null. Warnings: ${warnings.join(' ') || '(none — worse: it failed silently)'}`,
        );
      }

      expect(statSync(videoPath).size).toBeGreaterThan(0);
      // The merged DASH output is webm; asserting `.mp4` here is what the
      // production code used to do wrong.
      expect(videoPath).toMatch(/\.(mp4|webm|mkv)$/);
    });

    it('produces frames through the full pipeline', async (ctx) => {
      const params = resolveAnalyzeParams({ detail: 'standard', forceRefresh: true });
      const { result, cleanup } = await getAnalysis(TEST_LOOM_URL, params);

      try {
        if (result.frames.length === 0 && isVideoUnavailable(result.warnings.join(' '))) {
          ctx.skip(`TEST_LOOM_URL is unavailable: ${result.warnings.join(' ')}`);
        }

        // The symptom reported in #24: transcript fine, frames empty.
        expect(result.transcript.length).toBeGreaterThan(0);
        expect(result.frames.length).toBeGreaterThan(0);
        expect(result.warnings.join(' ')).not.toContain('Frame extraction not available');
        for (const frame of result.frames) {
          expect(existsSync(frame.filePath)).toBe(true);
        }
      } finally {
        await cleanup();
      }
    });
  });
});
