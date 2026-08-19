import { existsSync, writeFileSync } from 'node:fs';
import type * as NodeOs from 'node:os';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupTempDir,
  createTempDir,
  getTempFilePath,
  persistentCacheDir,
} from './temp-files.js';

// cacheRoot() branches on homedir() + process.platform + env; stub all three so
// every branch is covered on every host instead of only the runner's own.
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: vi.fn(() => '/home/u'),
}));

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

describe('persistentCacheDir', () => {
  // cacheRoot() has more branches than any one host executes: CI is ubuntu +
  // windows, so the darwin branch would otherwise run on ZERO machines, and the
  // security-relevant no-home fallback on none at all. Stub the inputs instead
  // of asserting a property of whichever branch the runner happened to pick —
  // the previous ambient assertion also went red in any HOME-less container,
  // for a fallback temp-files.ts documents as deliberate.
  const realPlatform = process.platform;
  const setPlatform = (value: string) =>
    Object.defineProperty(process, 'platform', { value, configurable: true });

  afterEach(() => {
    setPlatform(realPlatform);
    vi.unstubAllEnvs();
    vi.mocked(homedir).mockReturnValue('/home/u');
  });

  it.each([
    ['linux', '/home/u', join('/home/u', '.cache')],
    ['darwin', '/Users/u', join('/Users/u', 'Library', 'Caches')],
    ['win32', '/home/u', join('/home/u', 'AppData', 'Local')],
  ])('resolves the per-user cache dir on %s', (platform, home, expectedRoot) => {
    setPlatform(platform);
    vi.mocked(homedir).mockReturnValue(home);
    vi.stubEnv('MCP_CACHE_DIR', '');
    vi.stubEnv('XDG_CACHE_HOME', '');
    vi.stubEnv('LOCALAPPDATA', '');

    expect(persistentCacheDir('tessdata')).toBe(
      join(expectedRoot, 'mcp-video-analyzer', 'tessdata'),
    );
  });

  it('honours an absolute MCP_CACHE_DIR over everything else', () => {
    setPlatform('linux');
    vi.stubEnv('MCP_CACHE_DIR', '/opt/cache');
    vi.stubEnv('XDG_CACHE_HOME', '/xdg');
    expect(persistentCacheDir('tessdata')).toBe(
      join('/opt/cache', 'mcp-video-analyzer', 'tessdata'),
    );
  });

  it('honours an absolute XDG_CACHE_HOME on linux', () => {
    setPlatform('linux');
    vi.stubEnv('MCP_CACHE_DIR', '');
    vi.stubEnv('XDG_CACHE_HOME', '/xdg');
    expect(persistentCacheDir('tessdata')).toBe(join('/xdg', 'mcp-video-analyzer', 'tessdata'));
  });

  it.each(['MCP_CACHE_DIR', 'XDG_CACHE_HOME'])(
    'ignores a relative %s rather than resolving it against the cwd',
    (name) => {
      // The XDG spec requires a non-absolute value to be ignored, and a relative
      // root would put tessdata + frames under whatever dir the CLI was launched
      // from — the npx-pollutes-the-project-dir bug cachePath exists to prevent.
      setPlatform('linux');
      vi.stubEnv('MCP_CACHE_DIR', '');
      vi.stubEnv('XDG_CACHE_HOME', '');
      vi.stubEnv(name, '.cache');

      const dir = persistentCacheDir('tessdata');
      expect(isAbsolute(dir)).toBe(true);
      expect(dir).toBe(join('/home/u', '.cache', 'mcp-video-analyzer', 'tessdata'));
    },
  );

  it.each([
    ['an empty home', ''],
    ['a home of "/"', '/'],
  ])('falls back to a uid-keyed temp dir for %s', (_label, home) => {
    // Deliberate last resort, pinned so nobody "fixes" it into a cwd write or a
    // throw. It is uid-keyed rather than a fixed name so two users on one host
    // cannot collide — MCP_CACHE_DIR is the documented way out.
    setPlatform('linux');
    vi.stubEnv('MCP_CACHE_DIR', '');
    vi.stubEnv('XDG_CACHE_HOME', '');
    vi.mocked(homedir).mockReturnValue(home);

    const dir = persistentCacheDir('tessdata');
    expect(dir.startsWith(tmpdir())).toBe(true);
    expect(dir).toContain('mcp-cache-u');
  });

  it('survives homedir() throwing, which is what it does with no passwd entry', () => {
    // os.homedir() raises ERR_SYSTEM_ERROR rather than returning '' when $HOME
    // is unset and the uid has no passwd entry — the exact container shape the
    // fallback is for, so it must not escape as an exception.
    setPlatform('linux');
    vi.stubEnv('MCP_CACHE_DIR', '');
    vi.stubEnv('XDG_CACHE_HOME', '');
    vi.mocked(homedir).mockImplementation(() => {
      throw new Error('ERR_SYSTEM_ERROR: uv_os_homedir returned ENOENT');
    });

    expect(() => persistentCacheDir('tessdata')).not.toThrow();
    expect(persistentCacheDir('tessdata')).toContain('mcp-cache-u');
  });

  it('appends segments under one shared root', () => {
    expect(persistentCacheDir('a', 'b')).toBe(join(persistentCacheDir('a'), 'b'));
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
