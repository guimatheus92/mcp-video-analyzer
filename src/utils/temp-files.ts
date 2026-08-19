import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const activeTempDirs = new Set<string>();

export async function createTempDir(prefix = 'mcp-video-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  activeTempDirs.add(dir);
  return dir;
}

export async function cleanupTempDir(dirPath: string): Promise<void> {
  try {
    await rm(dirPath, { recursive: true, force: true });
  } finally {
    activeTempDirs.delete(dirPath);
  }
}

export function getTempFilePath(dir: string, name: string): string {
  return join(dir, name);
}

/**
 * Per-user cache root. `os.tmpdir()` is SHARED and world-traversable, so a
 * fixed name under it (the old `<tmp>/mcp-video-analyzer`) can be pre-created
 * by any other local user — who then reads every frame the CLI copies there and
 * can plant a `.traineddata` for our OCR to load. Nothing outside `$HOME` is
 * pre-creatable by someone else, and "regenerable data the OS may purge" is
 * exactly what the OS cache dir is for, so the reaping tmp gave us is kept.
 *
 * The `tmpdir()` fallback fires only where there is no usable home (a container
 * with no passwd entry) — single-user by construction, the one context in which
 * the shared-tmp hazard cannot apply.
 */
function cacheRoot(): string {
  const home = homedir();
  if (!home || home === '/') return tmpdir();
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  }
  if (process.platform === 'darwin') return join(home, 'Library', 'Caches');
  return process.env.XDG_CACHE_HOME || join(home, '.cache');
}

/**
 * Stable cross-run cache root: `<user-cache>/mcp-video-analyzer/<...segments>`.
 * Single definition for every persistent on-disk location (tessdata cache,
 * CLI frame output) — unlike `createTempDir` dirs, these survive the process.
 * Stays a pure path builder: callers do their own `mkdir`.
 */
export function persistentCacheDir(...segments: string[]): string {
  return join(cacheRoot(), 'mcp-video-analyzer', ...segments);
}

function cleanupAllTempDirs(): void {
  for (const dir of activeTempDirs) {
    rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  activeTempDirs.clear();
}

process.on('exit', cleanupAllTempDirs);
