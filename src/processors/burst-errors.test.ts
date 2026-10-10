import type * as ChildProcess from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '../utils/temp-files.js';
import { extractFrameBurst } from './frame-extractor.js';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcess>();
  const { promisify } = await import('node:util');
  const execFile = Object.assign(vi.fn(), { [promisify.custom]: run });
  return { ...actual, execFile };
});

let dir: string;
beforeEach(async () => {
  dir = await createTempDir('burst-errors-');
  run.mockReset();
});
afterEach(async () => {
  await cleanupTempDir(dir);
});

it('keeps command and path diagnostics out of the propagated message', async () => {
  const cause = new Error('Command failed: ffmpeg -i /private/video.mp4\nprivate stderr');
  run.mockRejectedValue(cause);
  await expect(extractFrameBurst('video.mp4', dir, '0:01', '0:02')).rejects.toMatchObject({
    message: 'Burst frame extraction failed.',
    cause,
  });
});

it.each([0, 1])(
  'rejects %i timestamps for two written images instead of dropping frames',
  async (count) => {
    run.mockImplementation(async (_bin: string, args: string[]) => {
      const pattern = args.find((arg) => arg.endsWith('burst_%03d.jpg'));
      if (!pattern) throw new Error('Missing output pattern');
      await writeFile(pattern.replace('%03d', '001'), 'fixture');
      await writeFile(pattern.replace('%03d', '002'), 'fixture');
      return { stderr: 'config in time_base: 1/10\n' + (count ? 'n: 0 pts: 10\n' : '') };
    });
    await expect(extractFrameBurst('video.mp4', dir, '0:01', '0:02')).rejects.toThrow(
      'Burst frame timestamp metadata is incomplete.',
    );
  },
);

it('allows a truly empty range when no images were written', async () => {
  run.mockResolvedValue({ stderr: 'config in time_base: 1/10\n' });
  await expect(extractFrameBurst('video.mp4', dir, '0:01', '0:02')).resolves.toEqual([]);
});
