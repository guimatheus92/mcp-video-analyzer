import { describe, expect, it, vi } from 'vitest';
import { createProgressReporter } from './progress.js';

describe('createProgressReporter', () => {
  it('calls reportProgress with progress and total', async () => {
    const mock = vi.fn().mockResolvedValue(undefined);
    const progress = createProgressReporter(mock);

    await progress(50);

    expect(mock).toHaveBeenCalledWith({ progress: 50, total: 100 });
  });

  it('includes message when provided', async () => {
    const mock = vi.fn().mockResolvedValue(undefined);
    const progress = createProgressReporter(mock);

    await progress(75, 'Extracting frames...');

    expect(mock).toHaveBeenCalledWith({
      progress: 75,
      total: 100,
      message: 'Extracting frames...',
    });
  });

  it('omits message field when not provided', async () => {
    const mock = vi.fn().mockResolvedValue(undefined);
    const progress = createProgressReporter(mock);

    await progress(0);

    const call = mock.mock.calls[0][0];
    expect(call).not.toHaveProperty('message');
  });

  it('uses custom total', async () => {
    const mock = vi.fn().mockResolvedValue(undefined);
    const progress = createProgressReporter(mock, 200);

    await progress(100, 'Halfway');

    expect(mock).toHaveBeenCalledWith({ progress: 100, total: 200, message: 'Halfway' });
  });
});
