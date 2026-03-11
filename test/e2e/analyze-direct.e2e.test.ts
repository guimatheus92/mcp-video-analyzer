import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  registerAdapter,
  clearAdapters,
  getAdapter,
} from '../../src/adapters/adapter.interface.js';
import { DirectAdapter } from '../../src/adapters/direct.adapter.js';
import { extractFrameAt, probeVideoDuration } from '../../src/processors/frame-extractor.js';
import { optimizeFrame } from '../../src/processors/image-optimizer.js';
import { createTempDir, cleanupTempDir } from '../../src/utils/temp-files.js';

import { TEST_DIRECT_VIDEO_URL as TEST_VIDEO_URL } from './fixtures.js';

describe('E2E: Direct video analysis', () => {
  let tempDir: string;

  beforeAll(async () => {
    clearAdapters();
    registerAdapter(new DirectAdapter());
    tempDir = await createTempDir('e2e-direct-');
  });

  afterAll(async () => {
    clearAdapters();
    if (tempDir) await cleanupTempDir(tempDir);
  });

  it('detects direct adapter for mp4 URL', () => {
    const adapter = getAdapter(TEST_VIDEO_URL);
    expect(adapter.name).toBe('direct');
  });

  it('downloads video successfully', async () => {
    const adapter = getAdapter(TEST_VIDEO_URL);
    const videoPath = await adapter.downloadVideo(TEST_VIDEO_URL, tempDir);

    expect(videoPath).not.toBeNull();
    expect(existsSync(videoPath!)).toBe(true);
  });

  it('probes video duration', async () => {
    const videoPath = join(tempDir, 'mov_bbb.mp4');
    if (!existsSync(videoPath)) return; // skip if download failed

    const duration = await probeVideoDuration(videoPath);
    expect(duration).toBeGreaterThan(0);
  });

  it('extracts a frame at timestamp', async () => {
    const videoPath = join(tempDir, 'mov_bbb.mp4');
    if (!existsSync(videoPath)) return;

    const frame = await extractFrameAt(videoPath, tempDir, '0:02');
    expect(existsSync(frame.filePath)).toBe(true);
    expect(frame.mimeType).toBe('image/jpeg');
  });

  it('optimizes extracted frame', async () => {
    const videoPath = join(tempDir, 'mov_bbb.mp4');
    if (!existsSync(videoPath)) return;

    const frame = await extractFrameAt(videoPath, tempDir, '0:01');
    const optimizedPath = join(tempDir, 'opt_test.jpg');
    await optimizeFrame(frame.filePath, optimizedPath);

    expect(existsSync(optimizedPath)).toBe(true);
  });

  it('returns empty transcript for direct videos', async () => {
    const adapter = getAdapter(TEST_VIDEO_URL);
    const transcript = await adapter.getTranscript(TEST_VIDEO_URL);
    expect(transcript).toEqual([]);
  });
});
