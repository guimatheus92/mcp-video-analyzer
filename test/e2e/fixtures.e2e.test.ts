import { describe, expect, it } from 'vitest';
import { isVideoUnavailable } from './fixtures.js';

/**
 * Guards the guard. `isVideoUnavailable` lets the Loom e2e tests skip when a
 * third-party video disappears — which is only safe while it stays narrow.
 * If it ever widens into "any failure → skip", those tests become no-ops and
 * issue #24 (a download silently returning null) walks straight back in.
 */
describe('isVideoUnavailable', () => {
  it.each([
    'getVideo returned PrivateVideo',
    'Loom CDN returned HTTP 404',
    'ERROR: [loom] abc: Video unavailable',
    'ERROR: This video does not exist',
    'The video has been removed by the owner',
  ])('treats %j as the video being gone', (evidence) => {
    expect(isVideoUnavailable(evidence)).toBe(true);
  });

  it.each([
    'Loom video download failed — yt-dlp is not installed',
    'Video download failed: ERROR: Requested format is not available',
    'Loom exposed no downloadable CDN URL for this video',
    'Loom CDN returned HTTP 500',
    'socket hang up',
    '',
    // Transient 404s on sub-resources: a fragment retry, a tessdata fetch.
    // These must fail loudly — excusing them turns the #24 regression test
    // into a no-op run that reports success.
    'ERROR: unable to download video data: HTTP Error 404: Not Found (fragment 3 of 40)',
    'Tesseract traineddata fetch failed: 404',
  ])('does NOT excuse %j', (evidence) => {
    expect(isVideoUnavailable(evidence)).toBe(false);
  });
});
