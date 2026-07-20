import { join } from 'node:path';
import { FIXTURES_DIR } from '../helpers/fixtures.js';

/**
 * Shared test fixtures for E2E tests.
 *
 * LOOM_TEST_URL: Public Loom demo video (Boost In-App Demo Video by Josh Owens, ~2:55).
 * Override via env var if this video becomes unavailable.
 */
export const TEST_LOOM_URL =
  process.env['LOOM_TEST_URL'] ?? 'https://www.loom.com/share/bdebdfe44b294225ac718bad241a94fe';

export const TEST_DIRECT_VIDEO_URL = 'https://www.w3schools.com/html/mov_bbb.mp4';

/** Absolute path to the bundled `tiny.mp4` fixture for local-file tests. */
export const TEST_LOCAL_VIDEO_PATH = join(FIXTURES_DIR, 'tiny.mp4');

/**
 * True only when the remote video itself is gone — deleted, made private, or
 * 404. Tests use this to skip instead of failing, because `TEST_LOOM_URL`
 * belongs to a third party and can disappear at any time.
 *
 * Deliberately NARROW. It matches the *cause*, never the symptom: a download
 * that merely returned null still fails the test loudly. Issue #24 hid for
 * months behind an e2e test that could not fail (`expect(path).toBeNull()`),
 * and a broad "any error → skip" would rebuild exactly that blind spot.
 */
export function isVideoUnavailable(evidence: string): boolean {
  return /PrivateVideo|HTTP 404|\b404\b|video unavailable|does not exist|has been removed|no longer available/i.test(
    evidence,
  );
}
