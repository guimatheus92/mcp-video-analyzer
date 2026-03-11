import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clearAdapters,
  getAdapter,
  registerAdapter,
} from '../../src/adapters/adapter.interface.js';
import { LoomAdapter } from '../../src/adapters/loom.adapter.js';
import { TEST_LOOM_URL } from './fixtures.js';

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

  it('returns null for video download (no auth)', async () => {
    const adapter = getAdapter(TEST_LOOM_URL);
    const videoPath = await adapter.downloadVideo(TEST_LOOM_URL, '/tmp');

    expect(videoPath).toBeNull();
  });
});
