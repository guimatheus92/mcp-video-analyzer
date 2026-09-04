import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  detectPlatform,
  extractLoomId,
  isVideoSource,
  sourceRejectionMessage,
  toLocalPath,
} from './url-detector.js';

describe('detectPlatform', () => {
  it('detects Loom share URLs', () => {
    expect(detectPlatform('https://www.loom.com/share/abc123def456')).toBe('loom');
  });

  it('detects Loom share URLs without www', () => {
    expect(detectPlatform('https://loom.com/share/abc123def456')).toBe('loom');
  });

  it('detects Loom embed URLs', () => {
    expect(detectPlatform('https://www.loom.com/embed/abc123def456')).toBe('loom');
  });

  it('detects Loom URLs with query params', () => {
    expect(detectPlatform('https://www.loom.com/share/abc123?sid=xyz')).toBe('loom');
  });

  it('detects direct .mp4 URLs', () => {
    expect(detectPlatform('https://example.com/video.mp4')).toBe('direct');
  });

  it('detects direct .webm URLs', () => {
    expect(detectPlatform('https://example.com/video.webm')).toBe('direct');
  });

  it('detects direct .mov URLs', () => {
    expect(detectPlatform('https://example.com/video.mov')).toBe('direct');
  });

  it('detects direct .avi URLs', () => {
    expect(detectPlatform('https://example.com/video.avi')).toBe('direct');
  });

  it('detects direct .mkv URLs', () => {
    expect(detectPlatform('https://example.com/video.mkv')).toBe('direct');
  });

  it('detects direct .m4v URLs', () => {
    expect(detectPlatform('https://example.com/video.m4v')).toBe('direct');
  });

  it('detects additional direct video container formats', () => {
    for (const ext of ['wmv', 'flv', 'mpeg', 'mpg', 'm2ts', 'mts', '3gp', 'ogv']) {
      expect(detectPlatform(`https://example.com/video.${ext}`)).toBe('direct');
    }
  });

  it('does not treat .ts (TypeScript) paths as video', () => {
    expect(detectPlatform('https://example.com/module.ts')).toBeNull();
    expect(detectPlatform('/Users/me/src/index.ts')).toBeNull();
  });

  it('detects YouTube URLs as ytdlp', () => {
    expect(detectPlatform('https://www.youtube.com/watch?v=abc123')).toBe('ytdlp');
    expect(detectPlatform('https://www.youtube.com/watch?foo=1&v=abc123')).toBe('ytdlp');
    expect(detectPlatform('https://youtube.com/shorts/abc123')).toBe('ytdlp');
    expect(detectPlatform('https://m.youtube.com/watch?v=abc123')).toBe('ytdlp');
    expect(detectPlatform('https://www.youtube.com/live/abc123')).toBe('ytdlp');
    expect(detectPlatform('https://youtu.be/abc123')).toBe('ytdlp');
  });

  it('detects other yt-dlp platforms as ytdlp', () => {
    expect(detectPlatform('https://vimeo.com/123456789')).toBe('ytdlp');
    expect(detectPlatform('https://www.tiktok.com/@user/video/1234567890')).toBe('ytdlp');
    expect(detectPlatform('https://www.instagram.com/reel/AbC123/')).toBe('ytdlp');
    expect(detectPlatform('https://www.instagram.com/p/AbC123/')).toBe('ytdlp');
    expect(detectPlatform('https://x.com/user/status/1234567890')).toBe('ytdlp');
    expect(detectPlatform('https://twitter.com/user/status/1234567890')).toBe('ytdlp');
    expect(detectPlatform('https://www.twitch.tv/videos/123456789')).toBe('ytdlp');
    expect(detectPlatform('https://www.twitch.tv/streamer/clip/SomeClip-abc')).toBe('ytdlp');
    expect(detectPlatform('https://clips.twitch.tv/SomeClip-abc')).toBe('ytdlp');
    expect(detectPlatform('https://www.dailymotion.com/video/x8abc12')).toBe('ytdlp');
    expect(detectPlatform('https://www.facebook.com/watch?v=1234567890')).toBe('ytdlp');
    expect(detectPlatform('https://www.facebook.com/somepage/videos/1234567890')).toBe('ytdlp');
    expect(detectPlatform('https://fb.watch/abc123/')).toBe('ytdlp');
  });

  it('rejects playlist/channel/profile pages (single videos only)', () => {
    expect(detectPlatform('https://www.youtube.com/playlist?list=PL123')).toBeNull();
    expect(detectPlatform('https://www.youtube.com/@somechannel')).toBeNull();
    expect(detectPlatform('https://www.instagram.com/someuser/')).toBeNull();
    expect(detectPlatform('https://www.twitch.tv/streamername')).toBeNull();
    expect(detectPlatform('https://vimeo.com/user12345')).toBeNull();
  });

  it('rejects listing pages that lack a video id', () => {
    expect(detectPlatform('https://www.instagram.com/reels/')).toBeNull(); // Reels feed
    expect(detectPlatform('https://www.facebook.com/somepage/videos/')).toBeNull(); // videos tab
    expect(detectPlatform('https://www.facebook.com/reel/')).toBeNull();
    expect(detectPlatform('https://www.facebook.com/watch/')).toBeNull();
  });

  it('accepts id-bearing variants of the tightened patterns', () => {
    expect(detectPlatform('https://www.instagram.com/reels/AbC12_3/')).toBe('ytdlp');
    expect(detectPlatform('https://www.facebook.com/reel/1234567890')).toBe('ytdlp');
    expect(detectPlatform('https://www.facebook.com/somepage/videos/9876543210/')).toBe('ytdlp');
  });

  it('returns null for HTML pages', () => {
    expect(detectPlatform('https://example.com/page.html')).toBeNull();
  });

  it('returns null for non-video URLs', () => {
    expect(detectPlatform('https://example.com/some-page')).toBeNull();
  });

  it('returns null for invalid URLs', () => {
    expect(detectPlatform('not-a-url')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(detectPlatform('')).toBeNull();
  });

  it('handles case-insensitive extensions', () => {
    expect(detectPlatform('https://example.com/VIDEO.MP4')).toBe('direct');
  });

  it('detects absolute POSIX paths to video files as local', () => {
    expect(detectPlatform('/Users/me/Movies/clip.mp4')).toBe('local');
    expect(detectPlatform('/tmp/video.webm')).toBe('local');
    expect(detectPlatform('/tmp/recording.mkv')).toBe('local');
    expect(detectPlatform('/tmp/camera.mts')).toBe('local');
  });

  it('detects file:// URIs as local', () => {
    // Derive the URI from a real absolute path so it is valid on the host OS —
    // a hardcoded POSIX `file://` literal throws under fileURLToPath on Windows.
    expect(detectPlatform(pathToFileURL(resolve('Movies', 'clip.mp4')).href)).toBe('local');
    expect(detectPlatform(pathToFileURL(resolve('tmp', 'video.mov')).href)).toBe('local');
  });

  // Windows drive paths are only absolute on win32; guard so the suite stays
  // green on POSIX CI too.
  (process.platform === 'win32' ? it : it.skip)('detects Windows drive paths as local', () => {
    expect(detectPlatform('C:\\Users\\me\\clip.mp4')).toBe('local');
    expect(detectPlatform('C:\\Users\\me\\notes.txt')).toBeNull();
  });

  it('returns null for absolute paths that are not video files', () => {
    expect(detectPlatform('/Users/me/notes.txt')).toBeNull();
    expect(detectPlatform('/tmp/page.html')).toBeNull();
  });

  it('returns null for relative paths', () => {
    expect(detectPlatform('./video.mp4')).toBeNull();
    expect(detectPlatform('video.mp4')).toBeNull();
    expect(detectPlatform('../movies/clip.mp4')).toBeNull();
  });
});

// GHSA-hpmc-4g74-v53v. Every URL below classified as 'direct' before the fix —
// the extension was the only thing checked, so the destination never was.
// Proven against the pre-fix code, not asserted: see the PoC table below.
describe('detectPlatform — blocked network destinations', () => {
  it.each([
    ['http://127.0.0.1:8931/x.mp4'], // the reporter's own PoC
    ['http://127.0.0.1/video.mp4'],
    ['http://localhost:8080/clip.mp4'],
    ['http://LocalHost/clip.mp4'],
    ['http://api.localhost/clip.mp4'],
    ['http://nas.local/movie.mkv'],
    ['http://[::1]:8080/x.mp4'],
    ['http://192.168.1.5/clip.mp4'],
    ['http://10.0.0.7/clip.mp4'],
    ['http://172.16.4.2/clip.mp4'],
    ['http://0.0.0.0:8080/x.mp4'],
    ['http://100.64.0.1/x.mp4'],
    ['https://169.254.169.254/latest.mp4'], // cloud metadata
    ['http://168.63.129.16/x.mp4'],
    ['http://user:pass@10.0.0.5/x.mp4'], // credentials must not smuggle a host past
  ])('rejects %s', (url) => {
    expect(detectPlatform(url)).toBeNull();
    expect(isVideoSource(url)).toBe(false);
  });

  it.each([
    ['ftp://example.com/video.mp4'],
    ['data:text/plain,x.mp4'],
    ['gopher://example.com/x.mp4'],
    ['blob:https://example.com/abcd.mp4'],
  ])('rejects the non-http scheme in %s', (url) => {
    expect(detectPlatform(url)).toBeNull();
  });

  it('still accepts public hosts that merely look unusual', () => {
    expect(detectPlatform('http://93.184.216.34/video.mp4')).toBe('direct');
    expect(detectPlatform('https://cdn.example.com:8443/video.mp4')).toBe('direct');
    // 172.15 and 172.64 sit just outside the blocked 172.16/12 and 172.32/11.
    expect(detectPlatform('http://172.15.0.1/video.mp4')).toBe('direct');
    expect(detectPlatform('http://172.64.0.1/video.mp4')).toBe('direct');
  });

  it('rejects UNC paths, which reach the network over SMB', () => {
    // Backslash form is checked on every platform; see isUncPath.
    expect(detectPlatform('\\\\attacker.example\\share\\x.mp4')).toBeNull();
  });

  (process.platform === 'win32' ? it : it.skip)(
    'rejects a file:// URI whose authority makes it a UNC path',
    () => {
      expect(detectPlatform('file://attacker.example/share/x.mp4')).toBeNull();
    },
  );

  it('lets the operator opt back in with MCP_ALLOW_PRIVATE_URLS', () => {
    // Without this the opt-in could be dead code and every assertion above
    // would still pass. It must NOT unlock metadata or the scheme check.
    vi.stubEnv('MCP_ALLOW_PRIVATE_URLS', '1');

    expect(detectPlatform('http://192.168.1.5/clip.mp4')).toBe('direct');
    expect(detectPlatform('http://localhost:8080/clip.mp4')).toBe('direct');
    expect(detectPlatform('\\\\nas.example\\share\\x.mp4')).toBe('local');

    expect(detectPlatform('https://169.254.169.254/latest.mp4')).toBeNull();
    expect(detectPlatform('ftp://example.com/video.mp4')).toBeNull();

    vi.unstubAllEnvs();
  });
});

describe('sourceRejectionMessage', () => {
  it('points a LAN user at the opt-in instead of at a typo hunt', () => {
    const message = sourceRejectionMessage('http://192.168.1.5/clip.mp4');
    expect(message).toMatch(/private or loopback/i);
    expect(message).toMatch(/MCP_ALLOW_PRIVATE_URLS=1/);
  });

  it('does not offer the opt-in for metadata, which it cannot unlock', () => {
    const message = sourceRejectionMessage('https://169.254.169.254/latest.mp4');
    expect(message).toMatch(/metadata endpoint/i);
    expect(message).not.toMatch(/MCP_ALLOW_PRIVATE_URLS/);
  });

  it('names the scheme problem rather than the generic shape problem', () => {
    expect(sourceRejectionMessage('ftp://example.com/video.mp4')).toMatch(/only http/i);
  });

  it('names UNC paths', () => {
    expect(sourceRejectionMessage('\\\\attacker.example\\share\\x.mp4')).toMatch(/UNC/);
  });

  it('falls back to the original wording for a genuinely unsupported source', () => {
    expect(sourceRejectionMessage('https://example.com/page.html')).toMatch(
      /Must be a supported video URL/,
    );
    expect(sourceRejectionMessage('./relative.mp4')).toMatch(/Must be a supported video URL/);
    expect(sourceRejectionMessage(42)).toMatch(/Must be a supported video URL/);
  });
});

describe('toLocalPath', () => {
  it('returns the path unchanged for absolute POSIX paths', () => {
    expect(toLocalPath('/tmp/video.mp4')).toBe('/tmp/video.mp4');
  });

  it('converts file:// URIs to fs paths', () => {
    const abs = resolve('tmp', 'video.mp4');
    expect(toLocalPath(pathToFileURL(abs).href)).toBe(abs);
  });

  it('returns null for HTTP URLs', () => {
    expect(toLocalPath('https://example.com/video.mp4')).toBeNull();
  });

  it('returns null for relative paths', () => {
    expect(toLocalPath('./video.mp4')).toBeNull();
    expect(toLocalPath('video.mp4')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(toLocalPath('')).toBeNull();
  });
});

describe('isVideoSource', () => {
  it('accepts Loom URLs', () => {
    expect(isVideoSource('https://loom.com/share/abc123')).toBe(true);
  });

  it('accepts direct video URLs', () => {
    expect(isVideoSource('https://example.com/video.mp4')).toBe(true);
  });

  it('accepts absolute paths to video files', () => {
    expect(isVideoSource('/tmp/video.mp4')).toBe(true);
  });

  it('accepts file:// URIs to video files', () => {
    // Same reason as the detectPlatform case above: a hardcoded POSIX literal
    // throws under fileURLToPath on Windows. It used to pass here anyway,
    // because the unparsable path fell through to the URL branch and the `.mp4`
    // pathname classified it as 'direct' — a file:// URI routed to the HTTP
    // downloader. The scheme check removed that fallthrough.
    expect(isVideoSource(pathToFileURL(resolve('tmp', 'video.mp4')).href)).toBe(true);
  });

  it('rejects relative paths', () => {
    expect(isVideoSource('./video.mp4')).toBe(false);
  });

  it('rejects non-video URLs', () => {
    expect(isVideoSource('https://example.com/page.html')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isVideoSource('')).toBe(false);
  });
});

describe('extractLoomId', () => {
  it('extracts ID from share URL', () => {
    expect(extractLoomId('https://www.loom.com/share/abc123def456')).toBe('abc123def456');
  });

  it('extracts ID from embed URL', () => {
    expect(extractLoomId('https://www.loom.com/embed/abc123def456')).toBe('abc123def456');
  });

  it('extracts ID without query params polluting it', () => {
    expect(extractLoomId('https://www.loom.com/share/abc123def456?sid=xyz')).toBe('abc123def456');
  });

  it('extracts UUID-style IDs', () => {
    expect(extractLoomId('https://www.loom.com/share/a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    );
  });

  it('returns null for non-Loom URLs', () => {
    expect(extractLoomId('https://example.com/video.mp4')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractLoomId('')).toBeNull();
  });

  it('returns null for Loom URLs without share/embed path', () => {
    expect(extractLoomId('https://www.loom.com/pricing')).toBeNull();
  });
});
