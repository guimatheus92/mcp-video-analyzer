import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Platform } from '../types.js';

const LOOM_PATTERN = /^https?:\/\/(?:www\.)?loom\.com\/(?:share|embed)\/([a-f0-9-]+)/i;

// Platform pages the yt-dlp adapter handles. Single-video pages only —
// playlists, channels, and profiles stay rejected.
const YTDLP_PATTERNS: RegExp[] = [
  /^https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/)[\w-]+/i,
  /^https?:\/\/youtu\.be\/[\w-]+/i,
  /^https?:\/\/(?:www\.)?vimeo\.com\/\d+/i,
  /^https?:\/\/(?:www\.)?tiktok\.com\/@[^/]+\/video\/\d+/i,
  /^https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p|tv)\//i,
  /^https?:\/\/(?:www\.|mobile\.)?(?:twitter|x)\.com\/[^/]+\/status\/\d+/i,
  /^https?:\/\/(?:www\.|m\.)?twitch\.tv\/(?:videos\/\d+|[^/]+\/clip\/)/i,
  /^https?:\/\/clips\.twitch\.tv\/[\w-]+/i,
  /^https?:\/\/(?:www\.)?dailymotion\.com\/video\/\w+/i,
  /^https?:\/\/(?:www\.|m\.)?facebook\.com\/(?:watch\/?\?v=|[^/]+\/videos\/|reel\/)/i,
  /^https?:\/\/fb\.watch\/[\w-]+/i,
];

// Single source of truth for which extensions route to a video source (used by
// both local files and direct URLs). The extension only gates detection —
// ffmpeg does the actual demuxing, so most common containers work. `.ts` is
// intentionally excluded: it collides with the TypeScript source extension.
const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.webm',
  '.mov',
  '.avi',
  '.mkv',
  '.m4v',
  '.wmv',
  '.flv',
  '.mpeg',
  '.mpg',
  '.m2ts',
  '.mts',
  '.3gp',
  '.ogv',
]);

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

    // Before the extension check so platform pages win over path extensions.
    if (YTDLP_PATTERNS.some((p) => p.test(url))) {
      return 'ytdlp';
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
