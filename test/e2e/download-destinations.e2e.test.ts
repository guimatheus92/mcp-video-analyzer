import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const E2E_DIR = dirname(fileURLToPath(import.meta.url));

/** `downloadVideo(<something>, <destDir>` — captures the second argument. */
const DOWNLOAD_CALL = /\bdownloadVideo\(\s*[^,]+,\s*([^,)]+)/g;

/**
 * True when the destination is a hardcoded path rather than a temp dir.
 *
 * Exported so it can be tested against the code that actually shipped the
 * problem — a guard verified only against a hand-written example is how the
 * first version of the issue #24 source guard passed while missing the bug.
 */
export function isHardcodedDestination(arg: string): boolean {
  return /^['"`]/.test(arg.trim());
}

export function downloadDestinations(source: string): string[] {
  return [...source.matchAll(DOWNLOAD_CALL)].map((m) => m[1].trim());
}

/**
 * Twice now, an e2e test has written a real download into a hardcoded `/tmp`:
 * `partial-results.e2e.test.ts` and `analyze-loom.e2e.test.ts`. Both were also
 * the tests that asserted the broken behaviour as correct, which is not a
 * coincidence — a hardcoded destination is what a test written to expect
 * failure looks like, because it never expected to create anything.
 *
 * Concretely it means: ~44MB left behind with no cleanup, and a path that is
 * not a directory on Windows, which CLAUDE.md treats as a first-class dev
 * platform (`pool: 'forks'` is documented as required there).
 */
describe('e2e download destinations', () => {
  const self = 'download-destinations.e2e.test.ts';
  const sources = readdirSync(E2E_DIR)
    // Skip this file: its own fixtures below quote the bad pattern on purpose.
    .filter((f) => f.endsWith('.e2e.test.ts') && f !== self)
    .map((f) => [f, readFileSync(join(E2E_DIR, f), 'utf-8')] as const)
    .filter(([, source]) => downloadDestinations(source).length > 0);

  it('finds downloadVideo call sites to check', () => {
    // A guard that scans nothing passes forever. Fail loudly instead.
    expect(sources.length).toBeGreaterThan(0);
  });

  it.each(sources.map(([name]) => name))('%s downloads into a temp dir', (name) => {
    const source = sources.find(([f]) => f === name)?.[1] ?? '';

    for (const destination of downloadDestinations(source)) {
      expect(
        isHardcodedDestination(destination),
        `${name}: downloadVideo() writes into the hardcoded path ${destination}. Use ` +
          `createTempDir()/cleanupTempDir() — a real download lands here, and /tmp is ` +
          `not a directory on Windows.`,
      ).toBe(false);
    }
  });
});

describe('isHardcodedDestination', () => {
  it('rejects the destination that actually shipped twice', () => {
    // Verbatim from test/e2e/partial-results.e2e.test.ts before it was removed.
    const shipped = "const videoPath = await adapter.downloadVideo(TEST_LOOM_URL, '/tmp');";
    const [destination] = downloadDestinations(shipped);

    expect(destination).toBe("'/tmp'");
    expect(isHardcodedDestination(destination)).toBe(true);
  });

  it('accepts a temp dir variable', () => {
    const ok = 'await adapter.downloadVideo(TEST_LOOM_URL, tempDir, (w) => warnings.push(w));';
    expect(isHardcodedDestination(downloadDestinations(ok)[0])).toBe(false);
  });
});
