import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clearAdapters,
  getAdapter,
  registerAdapter,
} from '../../src/adapters/adapter.interface.js';
import { DirectAdapter } from '../../src/adapters/direct.adapter.js';
import { LoomAdapter } from '../../src/adapters/loom.adapter.js';
import { deduplicateFrames } from '../../src/processors/frame-dedup.js';
import { extractFrameBurst, parseTimestamp } from '../../src/processors/frame-extractor.js';
import { optimizeFrames } from '../../src/processors/image-optimizer.js';
import { cleanupTempDir, createTempDir } from '../../src/utils/temp-files.js';
import { TEST_DIRECT_VIDEO_URL as TEST_VIDEO_URL } from './fixtures.js';

describe('E2E: analyze_moment with direct video', () => {
  let tempDir: string;
  let videoPath: string | null = null;

  beforeAll(async () => {
    clearAdapters();
    registerAdapter(new LoomAdapter());
    registerAdapter(new DirectAdapter());
    tempDir = await createTempDir('e2e-moment-');

    const adapter = getAdapter(TEST_VIDEO_URL);
    videoPath = await adapter.downloadVideo(TEST_VIDEO_URL, tempDir);
  });

  afterAll(async () => {
    clearAdapters();
    if (tempDir) await cleanupTempDir(tempDir);
  });

  it('parseTimestamp correctly parses time range', () => {
    expect(parseTimestamp('0:01')).toBe(1);
    expect(parseTimestamp('0:03')).toBe(3);
  });

  it('validates from < to', () => {
    const from = parseTimestamp('0:03');
    const to = parseTimestamp('0:01');
    expect(from).toBeGreaterThan(to); // invalid range
  });

  it('extracts burst frames in time range', async () => {
    if (!videoPath) return;

    const frames = await extractFrameBurst(videoPath, tempDir, '0:01', '0:03', 5);

    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThanOrEqual(5);
    for (const frame of frames) {
      expect(existsSync(frame.filePath)).toBe(true);
    }
  });

  it('optimizes burst frames', async () => {
    if (!videoPath) return;

    const optDir = await createTempDir('e2e-moment-opt-');
    try {
      const frames = await extractFrameBurst(videoPath, optDir, '0:01', '0:02', 3);
      if (frames.length === 0) return;

      const optimizedPaths = await optimizeFrames(
        frames.map((f) => f.filePath),
        optDir,
      );

      expect(optimizedPaths.length).toBe(frames.length);
      for (const p of optimizedPaths) {
        expect(existsSync(p)).toBe(true);
      }
    } finally {
      await cleanupTempDir(optDir);
    }
  });

  it('deduplicates burst frames', async () => {
    if (!videoPath) return;

    // Use a separate subdirectory to avoid file collisions with other burst tests
    const dedupDir = await createTempDir('e2e-moment-dedup-');
    try {
      const frames = await extractFrameBurst(videoPath, dedupDir, '0:01', '0:03', 5);
      if (frames.length < 2) return;

      const deduped = await deduplicateFrames(frames);
      expect(deduped.length).toBeGreaterThan(0);
      expect(deduped.length).toBeLessThanOrEqual(frames.length);
    } finally {
      await cleanupTempDir(dedupDir);
    }
  });

  it('transcript filtering for direct video returns empty (no transcript)', async () => {
    const adapter = getAdapter(TEST_VIDEO_URL);
    const transcript = await adapter.getTranscript(TEST_VIDEO_URL);

    const fromSeconds = 1;
    const toSeconds = 3;
    const filtered = transcript.filter((entry) => {
      const parts = entry.time.split(':').map(Number);
      const seconds = parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0];
      return seconds >= fromSeconds && seconds <= toSeconds;
    });

    expect(filtered).toEqual([]);
  });
});
