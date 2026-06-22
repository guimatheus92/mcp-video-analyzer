import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Platform } from '../types.js';

const LOOM_PATTERN = /^https?:\/\/(?:www\.)?loom\.com\/(?:share|embed)\/([a-f0-9-]+)/i;

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v']);

export function detectPlatform(url: string): Platform | null {
  if (!url) return null;

  const localPath = toLocalPath(url);
  if (localPath !== null) {
    const ext = getExtension(localPath);
    return ext && VIDEO_EXTENSIONS.has(ext) ? 'local' : null;
  }

  try {
    const parsed = new URL(url);

    if (LOOM_PATTERN.test(url)) {
      return 'loom';
    }

    const ext = getExtension(parsed.pathname);
    if (ext && VIDEO_EXTENSIONS.has(ext)) {
      return 'direct';
    }

    return null;
  } catch {
    return null;
  }
}

export function extractLoomId(url: string): string | null {
  if (!url) return null;

  const match = url.match(LOOM_PATTERN);
  return match ? match[1] : null;
}

/**
 * Resolve a `file://` URI or absolute fs path to an absolute local path.
 * Returns null for HTTP(S) URLs, relative paths, and anything else.
 */
export function toLocalPath(input: string): string | null {
  if (!input) return null;

  if (input.startsWith('file://')) {
    try {
      return fileURLToPath(input);
    } catch {
      return null;
    }
  }

  if (isAbsolute(input)) {
    return input;
  }

  return null;
}

/**
 * True if the input is a supported video source: an http(s) URL we recognize,
 * or an absolute local path / `file://` URI to a video file.
 *
 * Used by tool zod schemas. Relative paths are rejected — the MCP server's
 * working directory is unpredictable from the client's perspective.
 */
export function isVideoSource(input: string): boolean {
  return detectPlatform(input) !== null;
}

function getExtension(pathname: string): string | null {
  const lastDot = pathname.lastIndexOf('.');
  if (lastDot === -1) return null;
  return pathname.slice(lastDot).toLowerCase();
}
