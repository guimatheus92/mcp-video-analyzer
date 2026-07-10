import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
 * Stable cross-run cache root: `<tmp>/mcp-video-analyzer/<...segments>`.
 * Single definition for every persistent on-disk location (tessdata cache,
 * CLI frame output) — unlike `createTempDir` dirs, these survive the process.
 */
export function persistentCacheDir(...segments: string[]): string {
  return join(tmpdir(), 'mcp-video-analyzer', ...segments);
}

function cleanupAllTempDirs(): void {
  for (const dir of activeTempDirs) {
    rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  activeTempDirs.clear();
}

process.on('exit', cleanupAllTempDirs);
