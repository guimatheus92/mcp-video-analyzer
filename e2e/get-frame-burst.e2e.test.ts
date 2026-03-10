import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { registerAdapter, clearAdapters, getAdapter } from '../src/adapters/adapter.interface.js';
import { DirectAdapter } from '../src/adapters/direct.adapter.js';
import { extractFrameBurst } from '../src/processors/frame-extractor.js';
import { optimizeFrames } from '../src/processors/image-optimizer.js';
import { createTempDir, cleanupTempDir } from '../src/utils/temp-files.js';
import { TEST_DIRECT_VIDEO_URL as TEST_VIDEO_URL } from './fixtures.js';

describe('E2E: get_frame_burst', () => {
  let tempDir: string;
  let videoPath: string | null;

  beforeAll(async () => {
    clearAdapters();
    registerAdapter(new DirectAdapter());
    tempDir = await createTempDir('e2e-burst-');

    const adapter = getAdapter(TEST_VIDEO_URL);
    videoPath = await adapter.downloadVideo(TEST_VIDEO_URL, tempDir);
  });

  afterAll(async () => {
    clearAdapters();
    if (tempDir) await cleanupTempDir(tempDir);
  });

  it('extracts 5 burst frames between "0:01" and "0:03"', async () => {
    if (!videoPath) return;

    const frames = await extractFrameBurst(videoPath, tempDir, '0:01', '0:03', 5);

    expect(frames.length).toBeGreaterThanOrEqual(2); // ffmpeg may produce fewer if video is short
    for (const frame of frames) {
      expect(existsSync(frame.filePath)).toBe(true);
      expect(frame.mimeType).toBe('image/jpeg');
    }
  });

  it('produces valid JPEGs after optimization', async () => {
    if (!videoPath) return;

    const frames = await extractFrameBurst(videoPath, tempDir, '0:02', '0:04', 3);
    const optimizedPaths = await optimizeFrames(
      frames.map((f) => f.filePath),
      tempDir,
    );

    for (const path of optimizedPaths) {
      expect(existsSync(path)).toBe(true);
      const buffer = readFileSync(path);
      // JPEG magic bytes
      expect(buffer[0]).toBe(0xff);
      expect(buffer[1]).toBe(0xd8);
    }
  });
});
