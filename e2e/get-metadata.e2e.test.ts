import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registerAdapter, clearAdapters, getAdapter } from '../src/adapters/adapter.interface.js';
import { DirectAdapter } from '../src/adapters/direct.adapter.js';
import { LoomAdapter } from '../src/adapters/loom.adapter.js';
import { TEST_LOOM_URL, TEST_DIRECT_VIDEO_URL } from './fixtures.js';

describe('E2E: get_metadata with direct video', () => {
  beforeAll(() => {
    clearAdapters();
    registerAdapter(new LoomAdapter());
    registerAdapter(new DirectAdapter());
  });

  afterAll(() => {
    clearAdapters();
  });

  it('direct video returns basic metadata', async () => {
    const adapter = getAdapter(TEST_DIRECT_VIDEO_URL);
    const metadata = await adapter.getMetadata(TEST_DIRECT_VIDEO_URL);

    expect(metadata.platform).toBe('direct');
    expect(metadata.url).toBe(TEST_DIRECT_VIDEO_URL);
    expect(typeof metadata.duration).toBe('number');
  });

  it('direct video returns empty comments and chapters', async () => {
    const adapter = getAdapter(TEST_DIRECT_VIDEO_URL);

    const [comments, chapters, aiSummary] = await Promise.all([
      adapter.getComments(TEST_DIRECT_VIDEO_URL),
      adapter.getChapters(TEST_DIRECT_VIDEO_URL),
      adapter.getAiSummary(TEST_DIRECT_VIDEO_URL),
    ]);

    expect(comments).toEqual([]);
    expect(chapters).toEqual([]);
    expect(aiSummary).toBeNull();
  });
});

describe('E2E: get_metadata with Loom', () => {
  beforeAll(() => {
    clearAdapters();
    registerAdapter(new LoomAdapter());
    registerAdapter(new DirectAdapter());
  });

  afterAll(() => {
    clearAdapters();
  });

  it('Loom video returns full metadata', async () => {
    const adapter = getAdapter(TEST_LOOM_URL);
    const metadata = await adapter.getMetadata(TEST_LOOM_URL);

    expect(metadata.platform).toBe('loom');
    expect(metadata.title).toBeTruthy();
    expect(metadata.duration).toBeGreaterThan(0);
    expect(metadata.durationFormatted).toBeTruthy();
  });

  it('Loom video returns comments array', async () => {
    const adapter = getAdapter(TEST_LOOM_URL);
    const comments = await adapter.getComments(TEST_LOOM_URL);
    expect(Array.isArray(comments)).toBe(true);
  });

  it('Loom video returns chapters array', async () => {
    const adapter = getAdapter(TEST_LOOM_URL);
    const chapters = await adapter.getChapters(TEST_LOOM_URL);
    expect(Array.isArray(chapters)).toBe(true);
  });
});
