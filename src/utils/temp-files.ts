import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

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
 * Per-user cache root for everything persistent this process writes.
 *
 * WHY NOT `os.tmpdir()`: it is shared and world-traversable, so a fixed name
 * under it can be pre-created by any other local user — who then reads every
 * frame the CLI copies there and can plant a `.traineddata` for our OCR to
 * load. Another local user cannot pre-create a path inside this user's own
 * cache dir, which is what makes the fixed `mcp-video-analyzer` name safe here
 * and unsafe under tmp.
 *
 * LIFETIME: unlike tmp, nothing reaps this. `~/.cache` has no default reaper on
 * mainstream Linux (systemd-tmpfiles ships rules for /tmp, not $HOME),
 * `%LOCALAPPDATA%` is never purged by Windows, and macOS only reclaims
 * `~/Library/Caches` under disk pressure. Frames copied here therefore persist
 * until the user deletes them — deliberate, since repeat runs reuse the same
 * `<url-hash>` folder, but it is growth the temp dir used to bound. Callers
 * create these dirs with mode 0700 so the accumulation is at least private.
 *
 * ORDER: an explicit override wins, then the platform env var, then the home
 * directory. The env vars come first because the environment most likely to
 * have no usable home — a container started with `--user <uid>:<gid>` for a
 * uid with no passwd entry — is exactly where an operator sets one on purpose.
 * A non-absolute value is ignored (the XDG spec requires it, and a relative
 * root would resolve against the process cwd, which is the npx-pollutes-the-
 * agent's-project-dir bug `cachePath` exists to prevent).
 */
function cacheRoot(): string {
  for (const candidate of [
    process.env.MCP_CACHE_DIR,
    process.platform === 'win32' ? process.env.LOCALAPPDATA : undefined,
    process.platform === 'linux' ? process.env.XDG_CACHE_HOME : undefined,
  ]) {
    if (candidate && isAbsolute(candidate)) return candidate;
  }

  // os.homedir() THROWS (ERR_SYSTEM_ERROR) rather than returning '' when $HOME
  // is unset and the uid has no passwd entry — the very case the fallback below
  // is for — so it has to be treated as fallible.
  let home: string;
  try {
    home = homedir();
  } catch {
    home = '';
  }

  // Last resort: a fixed name back under the shared temp dir, i.e. the shape
  // this function exists to avoid. Keyed by uid so two users on one host cannot
  // collide or pre-create each other's. Reached when there is no usable home
  // and no override — set MCP_CACHE_DIR to an absolute path to opt out.
  if (!home || home === '/') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'nouid';
    return join(tmpdir(), `mcp-cache-u${uid}`); // ALLOW_FIXED_TMPDIR: documented last resort, uid-keyed
  }

  if (process.platform === 'win32') return join(home, 'AppData', 'Local');
  if (process.platform === 'darwin') return join(home, 'Library', 'Caches');
  return join(home, '.cache');
}

/**
 * Stable cross-run cache root: `<user-cache>/mcp-video-analyzer/<...segments>`.
 * Single definition for every persistent on-disk location (tessdata cache,
 * CLI frame output) — unlike `createTempDir` dirs, these survive the process.
 * Stays a pure path builder: callers do their own `mkdir` (with mode 0700).
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
