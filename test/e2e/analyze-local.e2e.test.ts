import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clearAdapters,
  getAdapter,
  registerAdapter,
} from '../../src/adapters/adapter.interface.js';
import { LocalFileAdapter } from '../../src/adapters/local-file.adapter.js';
import { extractFrameAt, probeVideoDuration } from '../../src/processors/frame-extractor.js';
import { optimizeFrame } from '../../src/processors/image-optimizer.js';
import { cleanupTempDir, createTempDir, getTempFilePath } from '../../src/utils/temp-files.js';
import { TEST_LOCAL_VIDEO_PATH } from './fixtures.js';

describe('E2E: Local file analysis', () => {
  let tempDir: string;

  beforeAll(async () => {
    clearAdapters();
    registerAdapter(new LocalFileAdapter());
    tempDir = await createTempDir('e2e-local-');
  });

  afterAll(async () => {
    clearAdapters();
    if (tempDir) await cleanupTempDir(tempDir);
  });

  it('detects local adapter for an absolute path', () => {
    const adapter = getAdapter(TEST_LOCAL_VIDEO_PATH);
    expect(adapter.name).toBe('local');
  });

  it('detects local adapter for a file:// URI', () => {
    const adapter = getAdapter(pathToFileURL(TEST_LOCAL_VIDEO_PATH).href);
    expect(adapter.name).toBe('local');
  });

  it('downloadVideo returns the source path unchanged', async () => {
    const adapter = getAdapter(TEST_LOCAL_VIDEO_PATH);
    const videoPath = await adapter.downloadVideo(TEST_LOCAL_VIDEO_PATH, tempDir);

    expect(videoPath).toBe(TEST_LOCAL_VIDEO_PATH);
    expect(existsSync(videoPath as string)).toBe(true);
  });

  it('probes duration of the local file', async () => {
    const duration = await probeVideoDuration(TEST_LOCAL_VIDEO_PATH);
    expect(duration).toBeGreaterThan(0);
  });

  it('extracts a frame at a timestamp from the local file', async () => {
    const frame = await extractFrameAt(TEST_LOCAL_VIDEO_PATH, tempDir, '0:01');
    expect(existsSync(frame.filePath)).toBe(true);
    expect(frame.mimeType).toBe('image/jpeg');
  });

  it('optimizes the extracted frame', async () => {
    const frame = await extractFrameAt(TEST_LOCAL_VIDEO_PATH, tempDir, '0:02');
    const optimizedPath = getTempFilePath(tempDir, 'opt_local.jpg');
    await optimizeFrame(frame.filePath, optimizedPath);

    expect(existsSync(optimizedPath)).toBe(true);
  });

  it('returns local-file metadata with basename as title', async () => {
    const adapter = getAdapter(TEST_LOCAL_VIDEO_PATH);
    const metadata = await adapter.getMetadata(TEST_LOCAL_VIDEO_PATH);

    expect(metadata.platform).toBe('local');
    expect(metadata.title).toBe('tiny.mp4');
  });
});
