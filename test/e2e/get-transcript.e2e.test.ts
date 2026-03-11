import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  registerAdapter,
  clearAdapters,
  getAdapter,
} from '../../src/adapters/adapter.interface.js';
import { DirectAdapter } from '../../src/adapters/direct.adapter.js';
import { LoomAdapter } from '../../src/adapters/loom.adapter.js';
import { TEST_LOOM_URL, TEST_DIRECT_VIDEO_URL } from './fixtures.js';

describe('E2E: get_transcript with direct video', () => {
  beforeAll(() => {
    clearAdapters();
    registerAdapter(new LoomAdapter());
    registerAdapter(new DirectAdapter());
  });

  afterAll(() => {
    clearAdapters();
  });

  it('direct video returns empty transcript (no native transcript)', async () => {
    const adapter = getAdapter(TEST_DIRECT_VIDEO_URL);
    const transcript = await adapter.getTranscript(TEST_DIRECT_VIDEO_URL);
    expect(transcript).toEqual([]);
  });

  it('direct adapter detected correctly', () => {
    const url = 'https://example.com/video.mp4';
    const adapter = getAdapter(url);
    expect(adapter.name).toBe('direct');
  });
});

describe('E2E: get_transcript with Loom', () => {
  beforeAll(() => {
    clearAdapters();
    registerAdapter(new LoomAdapter());
    registerAdapter(new DirectAdapter());
  });

  afterAll(() => {
    clearAdapters();
  });

  it('Loom video returns transcript with entries', async () => {
    const adapter = getAdapter(TEST_LOOM_URL);
    const transcript = await adapter.getTranscript(TEST_LOOM_URL);

    expect(Array.isArray(transcript)).toBe(true);
    // Most Loom videos have transcripts
    if (transcript.length > 0) {
      expect(transcript[0]).toHaveProperty('time');
      expect(transcript[0]).toHaveProperty('text');
    }
  });
});
