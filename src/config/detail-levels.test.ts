import { describe, expect, it } from 'vitest';
import { DETAIL_CONFIGS, getDetailConfig } from './detail-levels.js';
import type { DetailLevel } from './detail-levels.js';

describe('detail-levels', () => {
  it('brief config skips frames and limits transcript', () => {
    const config = getDetailConfig('brief');
    expect(config.includeFrames).toBe(false);
    expect(config.maxFrames).toBe(0);
    expect(config.transcriptMaxEntries).toBe(10);
    expect(config.includeOcr).toBe(false);
    expect(config.includeTimeline).toBe(false);
    expect(config.denseSampling).toBe(false);
  });

  it('standard config matches v0.1 defaults', () => {
    const config = getDetailConfig('standard');
    expect(config.includeFrames).toBe(true);
    expect(config.maxFrames).toBe(20);
    expect(config.transcriptMaxEntries).toBeNull();
    expect(config.includeOcr).toBe(true);
    expect(config.includeTimeline).toBe(true);
    expect(config.denseSampling).toBe(false);
  });

  it('detailed config enables dense sampling with higher frame limit', () => {
    const config = getDetailConfig('detailed');
    expect(config.includeFrames).toBe(true);
    expect(config.maxFrames).toBe(60);
    expect(config.transcriptMaxEntries).toBeNull();
    expect(config.includeOcr).toBe(true);
    expect(config.includeTimeline).toBe(true);
    expect(config.denseSampling).toBe(true);
  });

  it('all detail levels are defined', () => {
    const levels: DetailLevel[] = ['brief', 'standard', 'detailed'];
    for (const level of levels) {
      expect(DETAIL_CONFIGS[level]).toBeDefined();
    }
  });

  it('all configs have consistent property shapes', () => {
    const expectedKeys = [
      'maxFrames',
      'transcriptMaxEntries',
      'includeOcr',
      'includeTimeline',
      'includeFrames',
      'denseSampling',
    ];
    for (const config of Object.values(DETAIL_CONFIGS)) {
      for (const key of expectedKeys) {
        expect(config).toHaveProperty(key);
      }
    }
  });
});
