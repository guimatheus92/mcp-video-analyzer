import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clearAdapters,
  getAdapter,
  registerAdapter,
} from '../../src/adapters/adapter.interface.js';
import { DirectAdapter } from '../../src/adapters/direct.adapter.js';
import { LoomAdapter } from '../../src/adapters/loom.adapter.js';
import { getDetailConfig } from '../../src/config/detail-levels.js';
import {
  extractDenseFrames,
  extractSceneFrames,
  probeVideoDuration,
} from '../../src/processors/frame-extractor.js';
import { cleanupTempDir, createTempDir } from '../../src/utils/temp-files.js';
import { TEST_DIRECT_VIDEO_URL as TEST_VIDEO_URL } from './fixtures.js';

describe('E2E: Detail levels with direct video', () => {
  let tempDir: string;
  let videoPath: string | null = null;

  beforeAll(async () => {
    clearAdapters();
    registerAdapter(new LoomAdapter());
    registerAdapter(new DirectAdapter());
    tempDir = await createTempDir('e2e-detail-');

    const adapter = getAdapter(TEST_VIDEO_URL);
    videoPath = await adapter.downloadVideo(TEST_VIDEO_URL, tempDir);
  });

  afterAll(async () => {
    clearAdapters();
    if (tempDir) await cleanupTempDir(tempDir);
  });

  it('brief config: no frames, limited transcript', () => {
    const config = getDetailConfig('brief');
    expect(config.includeFrames).toBe(false);
    expect(config.maxFrames).toBe(0);
    expect(config.transcriptMaxEntries).toBe(10);
    expect(config.includeOcr).toBe(false);
    expect(config.includeTimeline).toBe(false);
  });

  it('standard config: scene-change frames, full transcript', () => {
    const config = getDetailConfig('standard');
    expect(config.includeFrames).toBe(true);
    expect(config.maxFrames).toBe(20);
    expect(config.transcriptMaxEntries).toBeNull();
    expect(config.denseSampling).toBe(false);
  });

  it('detailed config: dense sampling, more frames', () => {
    const config = getDetailConfig('detailed');
    expect(config.includeFrames).toBe(true);
    expect(config.maxFrames).toBe(60);
    expect(config.denseSampling).toBe(true);
  });

  it('standard: extracts scene-change frames from real video', async () => {
    if (!videoPath || !existsSync(videoPath)) return;

    const config = getDetailConfig('standard');
    const frames = await extractSceneFrames(videoPath, tempDir, {
      threshold: 0.1,
      maxFrames: config.maxFrames,
    });

    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThanOrEqual(config.maxFrames);
    for (const frame of frames) {
      expect(existsSync(frame.filePath)).toBe(true);
    }
  });

  it('detailed: extracts dense frames (1fps) from real video', async () => {
    if (!videoPath || !existsSync(videoPath)) return;

    const duration = await probeVideoDuration(videoPath);
    const config = getDetailConfig('detailed');
    const frames = await extractDenseFrames(videoPath, tempDir, {
      maxFrames: config.maxFrames,
    });

    expect(frames.length).toBeGreaterThan(0);
    // Dense sampling: roughly 1 frame per second (capped at maxFrames)
    expect(frames.length).toBeLessThanOrEqual(Math.min(Math.ceil(duration), config.maxFrames));
    for (const frame of frames) {
      expect(existsSync(frame.filePath)).toBe(true);
    }
  });
});
