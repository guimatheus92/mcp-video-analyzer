/**
 * Shared test fixtures for E2E tests.
 *
 * LOOM_TEST_URL: Public Loom demo video (Boost In-App Demo Video by Josh Owens, ~2:55).
 * Override via env var if this video becomes unavailable.
 */
export const TEST_LOOM_URL =
  process.env['LOOM_TEST_URL'] ?? 'https://www.loom.com/share/bdebdfe44b294225ac718bad241a94fe';

export const TEST_DIRECT_VIDEO_URL = 'https://www.w3schools.com/html/mov_bbb.mp4';
