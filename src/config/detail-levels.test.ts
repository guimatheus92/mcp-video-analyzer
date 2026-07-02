import { describe, expect, it } from 'vitest';
import { DETAIL_CONFIGS, getDetailConfig, resolveMaxFrames } from './detail-levels.js';
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

describe('resolveMaxFrames', () => {
  it('explicit value always wins, at every level', () => {
    expect(resolveMaxFrames(5, 'standard', 9999)).toBe(5);
    expect(resolveMaxFrames(5, 'brief', 10)).toBe(5);
    expect(resolveMaxFrames(5, 'detailed', 10)).toBe(5);
  });

  it('non-standard levels keep their fixed config', () => {
    expect(resolveMaxFrames(undefined, 'brief', 45)).toBe(0);
    expect(resolveMaxFrames(undefined, 'detailed', 45)).toBe(60);
  });

  it('unknown duration falls back to the fixed standard default', () => {
    expect(resolveMaxFrames(undefined, 'standard', 0)).toBe(20);
    expect(resolveMaxFrames(undefined, 'standard', -1)).toBe(20);
  });

  it('standard scales with duration at tier boundaries', () => {
    expect(resolveMaxFrames(undefined, 'standard', 30)).toBe(12);
    expect(resolveMaxFrames(undefined, 'standard', 31)).toBe(20);
    expect(resolveMaxFrames(undefined, 'standard', 60)).toBe(20);
    expect(resolveMaxFrames(undefined, 'standard', 61)).toBe(30);
    expect(resolveMaxFrames(undefined, 'standard', 180)).toBe(30);
    expect(resolveMaxFrames(undefined, 'standard', 181)).toBe(45);
    expect(resolveMaxFrames(undefined, 'standard', 600)).toBe(45);
    expect(resolveMaxFrames(undefined, 'standard', 601)).toBe(60);
  });
});
