import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir, getTempFilePath } from './temp-files.js';

const dirsToClean: string[] = [];

afterEach(async () => {
  for (const dir of dirsToClean) {
    await cleanupTempDir(dir).catch(() => undefined);
  }
  dirsToClean.length = 0;
});

describe('createTempDir', () => {
  it('creates a directory on disk', async () => {
    const dir = await createTempDir();
    dirsToClean.push(dir);

    expect(existsSync(dir)).toBe(true);
  });

  it('creates directories with the given prefix', async () => {
    const dir = await createTempDir('test-prefix-');
    dirsToClean.push(dir);

    expect(dir).toContain('test-prefix-');
  });
});

describe('cleanupTempDir', () => {
  it('removes the directory and its contents', async () => {
    const dir = await createTempDir();
    const filePath = join(dir, 'test.txt');
    writeFileSync(filePath, 'hello');

    expect(existsSync(filePath)).toBe(true);

    await cleanupTempDir(dir);

    expect(existsSync(dir)).toBe(false);
  });

  it('does not throw on double cleanup', async () => {
    const dir = await createTempDir();
    await cleanupTempDir(dir);
    await expect(cleanupTempDir(dir)).resolves.toBeUndefined();
  });
});

describe('getTempFilePath', () => {
  it('returns a path inside the temp dir', async () => {
    const dir = await createTempDir();
    dirsToClean.push(dir);

    const filePath = getTempFilePath(dir, 'frame_001.jpg');
    expect(filePath).toBe(join(dir, 'frame_001.jpg'));
  });
});
