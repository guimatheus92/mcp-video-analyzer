import { beforeEach, describe, expect, it } from 'vitest';
import { clearAdapters, getAdapter, registerAdapter } from './adapter.interface.js';
import { DirectAdapter } from './direct.adapter.js';
import { LoomAdapter } from './loom.adapter.js';

beforeEach(() => {
  clearAdapters();
});

describe('adapter registry', () => {
  it('throws UserError for unsupported URLs when no adapters registered', () => {
    expect(() => getAdapter('https://example.com')).toThrow('Unsupported video URL');
  });

  it('returns Loom adapter for loom.com URLs', () => {
    registerAdapter(new LoomAdapter());
    registerAdapter(new DirectAdapter());

    const adapter = getAdapter('https://www.loom.com/share/abc123');
    expect(adapter.name).toBe('loom');
  });

  it('returns Direct adapter for .mp4 URLs', () => {
    registerAdapter(new LoomAdapter());
    registerAdapter(new DirectAdapter());

    const adapter = getAdapter('https://example.com/video.mp4');
    expect(adapter.name).toBe('direct');
  });

  it('throws for unknown URLs even with adapters registered', () => {
    registerAdapter(new LoomAdapter());
    registerAdapter(new DirectAdapter());

    expect(() => getAdapter('https://example.com/page')).toThrow('Unsupported video URL');
  });

  it('returns first matching adapter (Loom before Direct)', () => {
    registerAdapter(new LoomAdapter());
    registerAdapter(new DirectAdapter());

    const adapter = getAdapter('https://www.loom.com/share/abc123');
    expect(adapter.name).toBe('loom');
  });
});
