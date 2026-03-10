import { createHash } from 'node:crypto';
import type { IAnalysisResult } from '../types.js';

interface CacheEntry {
  value: IAnalysisResult;
  expiresAt: number;
  createdAt: number;
}

interface CacheOptions {
  /** Time-to-live in milliseconds (default: 600_000 = 10 minutes) */
  ttlMs?: number;
  /** Maximum number of cached entries (default: 50) */
  maxEntries?: number;
}

interface CacheStats {
  size: number;
  hits: number;
  misses: number;
}

export class AnalysisCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private hits = 0;
  private misses = 0;

  constructor(options?: CacheOptions) {
    this.ttlMs = options?.ttlMs ?? 600_000;
    this.maxEntries = options?.maxEntries ?? 50;
  }

  get(key: string): IAnalysisResult | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return undefined;
    }

    this.hits++;
    return entry.value;
  }

  set(key: string, value: IAnalysisResult): void {
    // Evict oldest entry if at capacity
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      const oldestKey = this.findOldestKey();
      if (oldestKey) this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
      createdAt: Date.now(),
    });
  }

  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  stats(): CacheStats {
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
    };
  }

  private findOldestKey(): string | undefined {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt;
        oldestKey = key;
      }
    }

    return oldestKey;
  }
}

/**
 * Generate a deterministic cache key from a URL and optional parameters.
 */
export function cacheKey(url: string, params?: Record<string, unknown>): string {
  const input = params ? url + JSON.stringify(sortKeys(params)) : url;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return sorted;
}
