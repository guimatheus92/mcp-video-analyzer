/**
 * Map over `items` running at most `limit` calls of `fn` at a time, preserving
 * input order in the returned array. A fixed pool of workers pulls from a shared
 * cursor, so a slow item never blocks others beyond the concurrency cap.
 *
 * Contract: **`fn` must not reject.** It is awaited directly, so a single
 * rejection rejects the whole call and abandons in-flight work, leaving the
 * returned array sparse — the `Promise<R[]>` return type only holds if every
 * call resolves. Callers that need per-item error capture (e.g. the batch tool)
 * MUST catch inside `fn` and return a result object encoding the failure.
 * `onSettled` fires after each item resolves (for progress reporting).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onSettled?: (completed: number, total: number) => void,
): Promise<R[]> {
  const total = items.length;
  const results = new Array<R>(total);
  if (total === 0) return results;

  let next = 0;
  let completed = 0;
  const poolSize = Math.max(1, Math.min(Math.floor(limit) || 1, total));

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= total) return;
      results[index] = await fn(items[index], index);
      completed++;
      onSettled?.(completed, total);
    }
  }

  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return results;
}
