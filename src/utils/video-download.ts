import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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
 * Stream a direct video URL to `destDir` and return the written path, or `null`
 * if the response isn't OK / has no body. Shared by the Direct and TwelveLabs
 * adapters so frame-based tools work the same way for any direct URL.
 */
export async function downloadDirectVideo(url: string, destDir: string): Promise<string | null> {
  const destPath = join(destDir, getFilenameFromUrl(url));

  const response = await fetch(url);
  if (!response.ok || !response.body) {
    return null;
  }

  const nodeStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  await pipeline(nodeStream, createWriteStream(destPath));

  return destPath;
}
