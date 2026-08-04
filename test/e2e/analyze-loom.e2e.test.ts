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
import { TEST_LOOM_KNOWN_WORD, TEST_LOOM_URL, isVideoUnavailable } from './fixtures.js';

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

  it('fetches metadata with title and duration', async (ctx) => {
    const adapter = getAdapter(TEST_LOOM_URL);
    const metadata = await adapter.getMetadata(TEST_LOOM_URL).catch((e: unknown) => {
      // Only a positive "the video is gone" signal excuses this third-party
      // dependency (same carve-out as the download tests below); any other
      // error stays loud.
      if (isVideoUnavailable(String(e))) ctx.skip(`TEST_LOOM_URL is unavailable: ${String(e)}`);
      throw e;
    });

    expect(metadata.platform).toBe('loom');
    expect(metadata.title).toBeTruthy();
    expect(metadata.duration).toBeGreaterThan(0);
    expect(metadata.durationFormatted).toMatch(/^\d+:\d{2}/);
    expect(metadata.url).toBe(TEST_LOOM_URL);
  });

  it('fetches transcript entries with the known content', async (ctx) => {
    const adapter = getAdapter(TEST_LOOM_URL);
    const transcript = await adapter.getTranscript(TEST_LOOM_URL).catch((e: unknown) => {
      // A vanished third-party video must SKIP (positive evidence only, per
      // fixtures.ts isVideoUnavailable), not fail the PR-gating e2e job; a
      // pipeline error still fails loud.
      if (isVideoUnavailable(String(e))) ctx.skip(`TEST_LOOM_URL is unavailable: ${String(e)}`);
      throw e;
    });

    // The old `if (transcript.length > 0)` guard is the inverted-assertion
    // pattern from issue #24: the default video HAS a transcript, so an empty
    // result is a failure, not a variant to tolerate.
    expect(transcript.length).toBeGreaterThan(0);
    expect(transcript[0]).toHaveProperty('time');
    expect(transcript[0]).toHaveProperty('text');

    if (!process.env['LOOM_TEST_URL']) {
      // Ground-truth content check, not just shape. Skipped only under an
      // explicit operator override of the video URL — different video,
      // different words.
      const joined = transcript
        .map((e) => e.text)
        .join(' ')
        .toLowerCase();
      expect(joined).toContain(TEST_LOOM_KNOWN_WORD);
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
      // Deliberately NOT asserting a container: which one Loom serves is
      // exactly what the production code must stop assuming.
      expect(videoPath.startsWith(tempDir)).toBe(true);
    });

    it('produces frames through the full pipeline', async (ctx) => {
      const params = resolveAnalyzeParams({ detail: 'standard', forceRefresh: true });
      const { result, cleanup } = await getAnalysis(TEST_LOOM_URL, params);

      try {
        // Only the DOWNLOAD warnings may excuse a skip. Matching the whole
        // warnings blob would let an unrelated failure elsewhere in the
        // pipeline silence this regression test.
        const downloadWarnings = result.warnings
          .filter((w) => /download failed|download with cookies|not installed/i.test(w))
          .join(' ');
        if (result.frames.length === 0 && isVideoUnavailable(downloadWarnings)) {
          ctx.skip(`TEST_LOOM_URL is unavailable: ${downloadWarnings}`);
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
