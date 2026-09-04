import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Platform } from '../types.js';
import { allowPrivateUrls, blockedReasonMessage, isBlockedHostLiteral } from './ssrf-guard.js';

const LOOM_PATTERN = /^https?:\/\/(?:www\.)?loom\.com\/(?:share|embed)\/([a-f0-9-]+)/i;

// Platform pages the yt-dlp adapter handles. Single-video pages only —
// playlists, channels, and profiles stay rejected.
const YTDLP_PATTERNS: RegExp[] = [
  /^https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/)[\w-]+/i,
  /^https?:\/\/youtu\.be\/[\w-]+/i,
  /^https?:\/\/(?:www\.)?vimeo\.com\/\d+/i,
  /^https?:\/\/(?:www\.)?tiktok\.com\/@[^/]+\/video\/\d+/i,
  /^https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p|tv)\/[\w-]+/i,
  /^https?:\/\/(?:www\.|mobile\.)?(?:twitter|x)\.com\/[^/]+\/status\/\d+/i,
  /^https?:\/\/(?:www\.|m\.)?twitch\.tv\/(?:videos\/\d+|[^/]+\/clip\/)/i,
  /^https?:\/\/clips\.twitch\.tv\/[\w-]+/i,
  /^https?:\/\/(?:www\.)?dailymotion\.com\/video\/\w+/i,
  /^https?:\/\/(?:www\.|m\.)?facebook\.com\/(?:watch\/?\?v=\d+|[^/]+\/videos\/\d+|reel\/\d+)/i,
  /^https?:\/\/fb\.watch\/[\w-]+/i,
];

// Single source of truth for which extensions route to a video source (used by
// both local files and direct URLs). The extension only gates detection —
// ffmpeg does the actual demuxing, so most common containers work. `.ts` is
// intentionally excluded: it collides with the TypeScript source extension.
//
// Exported for the format-matrix drift guard in
// test/e2e/video-formats.e2e.test.ts: every entry here must be either decoded
// by that matrix or on its documented exclusion list, so adding an extension
// forces a test decision instead of silently shipping an untested container.
// ReadonlySet, not Set: this allowlist gates which paths and URLs
// detectPlatform accepts for processing, so an importer calling .add()/.clear()
// would mutate a trust-boundary decision at runtime. Every consumer is
// read-only already (.has / .size / spread), so this costs nothing and turns
// the invariant into a compile-time guarantee.
export const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
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

/**
 * Why an input is not a usable video source. `unsupported` is the pre-existing
 * "we don't recognize this" case; the rest are the network-destination refusals
 * added for GHSA-hpmc-4g74-v53v, kept as distinct reasons so the caller can say
 * something a user can act on rather than "unsupported URL".
 */
type Rejection = 'unsupported' | 'scheme' | 'blocked-metadata' | 'blocked-private' | 'unc';

/**
 * The single classification every entry point routes through: 8 MCP tools via
 * `isVideoSource` and the CLI via the same. It is therefore the network trust
 * boundary — a destination refused here is refused everywhere at once, which is
 * why the guard lives at this level rather than at each of the three sinks.
 *
 * Synchronous by contract (adapters call it from `canHandle`, and it keys the
 * analysis cache), so it can only do literal checks. Hostnames that merely
 * RESOLVE to an internal address are caught later, by `assertPublicUrl` at the
 * sink, which is allowed to do DNS.
 */
function classify(url: string): Platform | Rejection {
  if (!url) return 'unsupported';

  // A UNC path is not a local file: ffmpeg opens it over SMB, which is the same
  // lateral network reach as an http:// fetch, and on Windows the handshake
  // hands the attacker's host an NTLM credential.
  //
  // Checked BEFORE toLocalPath because `isAbsolute()` is false for a backslash
  // path on POSIX, so the verdict would otherwise degrade to a generic
  // "unsupported" purely based on which OS the server happens to run on. An MCP
  // config gets shared across machines; the refusal it gets should not vary.
  if (isUncPath(url) && !allowPrivateUrls()) return 'unc';

  const localPath = toLocalPath(url);
  if (localPath !== null) {
    // Again for the `file://host/share/...` spelling, which only becomes a UNC
    // path after fileURLToPath resolves it.
    if (isUncPath(localPath) && !allowPrivateUrls()) return 'unc';
    const ext = getExtension(localPath);
    return ext && VIDEO_EXTENSIONS.has(ext) ? 'local' : 'unsupported';
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'unsupported';
  }

  // `new URL()` parses any scheme, and Node's fetch natively handles `data:`,
  // so `data:text/plain,x.mp4` used to reach the direct branch.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'scheme';
  }

  const blocked = isBlockedHostLiteral(parsed.hostname);
  if (blocked === 'metadata') return 'blocked-metadata';
  if (blocked === 'private' && !allowPrivateUrls()) return 'blocked-private';

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

  return 'unsupported';
}

const REJECTIONS: ReadonlySet<string> = new Set<Rejection>([
  'unsupported',
  'scheme',
  'blocked-metadata',
  'blocked-private',
  'unc',
]);

export function detectPlatform(url: string): Platform | null {
  const result = classify(url);
  return REJECTIONS.has(result) ? null : (result as Platform);
}

const UNSUPPORTED_MESSAGE =
  'Must be a supported video URL (Loom, YouTube, Vimeo, TikTok, Instagram, X/Twitter, Twitch, Dailymotion, Facebook), a direct .mp4/.webm/.mov URL, or an absolute path / file:// URI to a local video file';

/**
 * The rejection message for a source the tools refused.
 *
 * Exists because the eight tool schemas carried this string verbatim, eight
 * times. A blocked-destination URL is a *supported shape* that was refused on
 * purpose, so reusing the generic text would send a user with a NAS on their
 * LAN hunting for a typo instead of at `MCP_ALLOW_PRIVATE_URLS`.
 */
export function sourceRejectionMessage(input: unknown): string {
  if (typeof input !== 'string') return UNSUPPORTED_MESSAGE;

  switch (classify(input)) {
    case 'scheme':
      return 'Only http:// and https:// URLs can be fetched (or an absolute path / file:// URI to a local video file).';
    case 'blocked-metadata':
      return blockedReasonMessage('metadata');
    case 'blocked-private':
      return blockedReasonMessage('private');
    case 'unc':
      return 'UNC and network share paths are not accepted. Set MCP_ALLOW_PRIVATE_URLS=1 to allow them.';
    default:
      return UNSUPPORTED_MESSAGE;
  }
}

/**
 * True for a Windows UNC path (`\\host\share\...`).
 *
 * The backslash form is refused on every platform: it is never a valid POSIX
 * path anyway, and refusing it uniformly keeps the verdict (and the error
 * message) the same wherever the server runs. The forward-slash form is
 * Windows-only, because `//foo/bar` is an ordinary path on POSIX and resolves
 * to local disk there, not to a network share.
 */
function isUncPath(path: string): boolean {
  if (/^\\\\[^\\/]/.test(path)) return true;
  return process.platform === 'win32' && /^\/\/[^/]/.test(path);
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
