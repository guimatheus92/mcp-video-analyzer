import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './concurrency.js';

describe('mapWithConcurrency', () => {
  it('preserves input order regardless of completion order', async () => {
    const items = [30, 10, 20, 5];
    const results = await mapWithConcurrency(items, 2, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 2;
    });
    expect(results).toEqual([60, 20, 40, 10]);
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency([...Array(10).keys()], 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('reports progress after each settled item', async () => {
    const seen: number[] = [];
    await mapWithConcurrency(
      [1, 2, 3],
      2,
      async (n) => n,
      (completed, total) => {
        expect(total).toBe(3);
        seen.push(completed);
      },
    );
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('returns an empty array for no items without invoking fn', async () => {
    let called = false;
    const results = await mapWithConcurrency([], 4, async () => {
      called = true;
      return 1;
    });
    expect(results).toEqual([]);
    expect(called).toBe(false);
  });

  it('clamps a limit larger than the item count', async () => {
    const results = await mapWithConcurrency([1, 2], 100, async (n) => n + 1);
    expect(results).toEqual([2, 3]);
  });
});
