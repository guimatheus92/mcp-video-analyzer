import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clearAdapters,
  getAdapter,
  registerAdapter,
} from '../../src/adapters/adapter.interface.js';
import { LoomAdapter } from '../../src/adapters/loom.adapter.js';
import { TEST_LOOM_URL } from './fixtures.js';

describe('E2E: Partial results (Loom, skipFrames)', () => {
  beforeAll(() => {
    clearAdapters();
    registerAdapter(new LoomAdapter());
  });

  afterAll(() => {
    clearAdapters();
  });

  it('returns metadata and transcript without frames', async () => {
    const adapter = getAdapter(TEST_LOOM_URL);

    // Fetch metadata and transcript in parallel (simulating skipFrames flow)
    const [metadata, transcript, comments] = await Promise.all([
      adapter.getMetadata(TEST_LOOM_URL),
      adapter.getTranscript(TEST_LOOM_URL),
      adapter.getComments(TEST_LOOM_URL),
    ]);

    // Metadata should always be present
    expect(metadata.platform).toBe('loom');
    expect(metadata.title).toBeTruthy();

    // Transcript and comments are arrays (may be empty but should not throw)
    expect(Array.isArray(transcript)).toBe(true);
    expect(Array.isArray(comments)).toBe(true);

    // No video download attempted = no frames
    const videoPath = await adapter.downloadVideo(TEST_LOOM_URL, '/tmp');
    expect(videoPath).toBeNull();
  });

  it('handles non-existent Loom video gracefully', async () => {
    const fakeUrl = 'https://www.loom.com/share/deadbeef00000000deadbeef00000000';
    const adapter = getAdapter(fakeUrl);
    const metadata = await adapter.getMetadata(fakeUrl);

    // Should return default metadata, not throw
    expect(metadata.platform).toBe('loom');
    expect(metadata.title).toBe('Untitled Loom Video');
  });
});
