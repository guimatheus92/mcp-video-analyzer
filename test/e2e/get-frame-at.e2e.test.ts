import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clearAdapters,
  getAdapter,
  registerAdapter,
} from '../../src/adapters/adapter.interface.js';
import { DirectAdapter } from '../../src/adapters/direct.adapter.js';
import { extractFrameAt } from '../../src/processors/frame-extractor.js';
import { optimizeFrame } from '../../src/processors/image-optimizer.js';
import { cleanupTempDir, createTempDir } from '../../src/utils/temp-files.js';
import { TEST_DIRECT_VIDEO_URL as TEST_VIDEO_URL } from './fixtures.js';

describe('E2E: get_frame_at', () => {
  let tempDir: string;
  let videoPath: string | null;

  beforeAll(async () => {
    clearAdapters();
    registerAdapter(new DirectAdapter());
    tempDir = await createTempDir('e2e-frame-at-');

    const adapter = getAdapter(TEST_VIDEO_URL);
    videoPath = await adapter.downloadVideo(TEST_VIDEO_URL, tempDir);
  });

  afterAll(async () => {
    clearAdapters();
    if (tempDir) await cleanupTempDir(tempDir);
  });

  it('extracts exactly 1 frame at timestamp "0:02"', async () => {
    if (!videoPath) return;

    const frame = await extractFrameAt(videoPath, tempDir, '0:02');

    expect(frame.time).toBe('0:02');
    expect(frame.mimeType).toBe('image/jpeg');
    expect(existsSync(frame.filePath)).toBe(true);
  });

  it('produces a valid optimized JPEG', async () => {
    if (!videoPath) return;

    const frame = await extractFrameAt(videoPath, tempDir, '0:03');
    const optimizedPath = join(tempDir, 'opt_frame.jpg');
    await optimizeFrame(frame.filePath, optimizedPath);

    expect(existsSync(optimizedPath)).toBe(true);

    // Check file starts with JPEG magic bytes
    const { readFileSync } = await import('node:fs');
    const buffer = readFileSync(optimizedPath);
    expect(buffer[0]).toBe(0xff);
    expect(buffer[1]).toBe(0xd8);
  });
});
