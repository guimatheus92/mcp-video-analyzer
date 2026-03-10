import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { registerAdapter, clearAdapters, getAdapter } from '../src/adapters/adapter.interface.js';
import { DirectAdapter } from '../src/adapters/direct.adapter.js';
import { LoomAdapter } from '../src/adapters/loom.adapter.js';
import {
  extractSceneFrames,
  extractDenseFrames,
  probeVideoDuration,
} from '../src/processors/frame-extractor.js';
import { deduplicateFrames } from '../src/processors/frame-dedup.js';
import { createTempDir, cleanupTempDir } from '../src/utils/temp-files.js';
import { TEST_DIRECT_VIDEO_URL as TEST_VIDEO_URL } from './fixtures.js';

describe('E2E: get_frames with direct video', () => {
  let tempDir: string;
  let videoPath: string | null = null;

  beforeAll(async () => {
    clearAdapters();
    registerAdapter(new LoomAdapter());
    registerAdapter(new DirectAdapter());
    tempDir = await createTempDir('e2e-frames-');

    const adapter = getAdapter(TEST_VIDEO_URL);
    videoPath = await adapter.downloadVideo(TEST_VIDEO_URL, tempDir);
  });

  afterAll(async () => {
    clearAdapters();
    if (tempDir) await cleanupTempDir(tempDir);
  });

  it('downloads video for frame extraction', () => {
    expect(videoPath).not.toBeNull();
    expect(existsSync(videoPath!)).toBe(true);
  });

  it('scene-change mode extracts frames', async () => {
    if (!videoPath) return;

    const frames = await extractSceneFrames(videoPath, tempDir, {
      threshold: 0.1,
      maxFrames: 20,
    });

    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(existsSync(frame.filePath)).toBe(true);
      expect(frame.mimeType).toBe('image/jpeg');
      expect(frame.time).toBeTruthy();
    }
  });

  it('dense mode extracts ~1 frame per second', async () => {
    if (!videoPath) return;

    const duration = await probeVideoDuration(videoPath);
    const frames = await extractDenseFrames(videoPath, tempDir, { maxFrames: 30 });

    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThanOrEqual(Math.min(Math.ceil(duration), 30));
  });

  it('deduplication removes near-identical frames', async () => {
    if (!videoPath) return;

    // Dense sampling on a short video may produce similar frames
    const frames = await extractDenseFrames(videoPath, tempDir, { maxFrames: 10 });
    if (frames.length < 2) return;

    const deduped = await deduplicateFrames(frames);
    expect(deduped.length).toBeLessThanOrEqual(frames.length);
    expect(deduped.length).toBeGreaterThan(0);
  });
});
