import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { assertPublicUrl } from './ssrf-guard.js';

/** Matches the default `fetch` redirect cap; a chain longer than this is a loop. */
const MAX_REDIRECTS = 20;

/**
 * Best-effort filename for a direct video URL, falling back to `video.mp4`
 * when the URL has no usable last path segment.
 */
export function getFilenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/');
    const lastSegment = segments[segments.length - 1];
    if (lastSegment && lastSegment.includes('.')) {
      return lastSegment;
    }
  } catch {
    // ignore parse errors
  }
  return 'video.mp4';
}

/**
 * `fetch`, but every hop of the redirect chain is checked against the SSRF
 * guard rather than only the URL the caller passed in.
 *
 * `redirect: 'follow'` (the default) would let a public host answer `302
 * Location: http://127.0.0.1/` and hand us the internal response anyway — the
 * first-hop-only check is exactly what mcp-searxng's CVE-2026-54689 was filed
 * for. Node's fetch returns the real 3xx with readable headers under
 * `'manual'`, so following it ourselves costs one loop.
 */
async function fetchPublicUrl(url: string): Promise<Response> {
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);
    const response = await fetch(current, { redirect: 'manual' });

    // Status first: a 200 or a 404 is the answer, and there is no reason to
    // touch headers on one.
    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    const location = response.headers.get('location');
    if (!location) {
      return response;
    }

    // Cancel the redirect body so the socket is released before the next hop.
    await response.body?.cancel();
    current = new URL(location, current).href;
  }

  throw new Error('Too many redirects while fetching the video.');
}

/**
 * Stream a direct video URL to `destDir` and return the written path, or `null`
 * if the response isn't OK / has no body. Shared by the Direct and TwelveLabs
 * adapters so frame-based tools work the same way for any direct URL.
 *
 * Throws (rather than returning null) when the destination is refused by the
 * SSRF guard: a silent null would read as "that video was not available",
 * hiding a deliberate refusal the caller should surface.
 */
export async function downloadDirectVideo(url: string, destDir: string): Promise<string | null> {
  const destPath = join(destDir, getFilenameFromUrl(url));

  const response = await fetchPublicUrl(url);
  if (!response.ok || !response.body) {
    return null;
  }

  const nodeStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  await pipeline(nodeStream, createWriteStream(destPath));

  return destPath;
}
