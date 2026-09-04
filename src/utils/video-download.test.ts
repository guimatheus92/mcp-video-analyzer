import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from './temp-files.js';
import { downloadDirectVideo, getFilenameFromUrl } from './video-download.js';

// Every hostname resolves to one public address. These tests are about which
// destinations the redirect loop accepts, not about resolution — and without
// this they would depend on `example.com` being reachable from the runner,
// which is the kind of "green because the network answered" the repo bans.
// The DNS-resolution behaviour itself is covered in ssrf-guard.test.ts.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

/** A minimal `fetch` reply carrying `body` as a real web stream. */
function ok(body: string): Response {
  return new Response(body, { status: 200 });
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

describe('getFilenameFromUrl', () => {
  it('uses the last path segment when it looks like a file', () => {
    expect(getFilenameFromUrl('https://example.com/videos/clip.mp4')).toBe('clip.mp4');
  });

  it('falls back to video.mp4 without a usable segment', () => {
    expect(getFilenameFromUrl('https://example.com/videos/')).toBe('video.mp4');
    expect(getFilenameFromUrl('not a url')).toBe('video.mp4');
  });
});

describe('downloadDirectVideo', () => {
  let tempDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await createTempDir();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
    await cleanupTempDir(tempDir);
  });

  it('writes the body for a public URL', async () => {
    fetchSpy.mockResolvedValue(ok('VIDEO-BYTES'));

    const path = await downloadDirectVideo('https://example.com/clip.mp4', tempDir);

    expect(path).not.toBeNull();
    await expect(readFile(path as string, 'utf8')).resolves.toBe('VIDEO-BYTES');
  });

  it('returns null when the response is not OK', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 404 }));

    await expect(downloadDirectVideo('https://example.com/clip.mp4', tempDir)).resolves.toBeNull();
  });

  it('refuses a loopback URL WITHOUT calling fetch', async () => {
    // The reporter's PoC. Asserting on fetch itself is the point: a guard that
    // ran after the request would still have hit the internal service.
    await expect(downloadDirectVideo('http://127.0.0.1:8931/x.mp4', tempDir)).rejects.toThrow(
      /private or loopback/i,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    'http://192.168.1.5/clip.mp4',
    'http://[::1]/clip.mp4',
    'http://169.254.169.254/latest.mp4',
    'ftp://example.com/clip.mp4',
  ])('refuses %s without calling fetch', async (url) => {
    await expect(downloadDirectVideo(url, tempDir)).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a redirect INTO a loopback address', async () => {
    // The first hop is public and passes the guard; only re-checking hop 2
    // catches this. With `redirect: 'follow'` the internal body would already
    // be in hand by the time any check ran.
    fetchSpy.mockResolvedValueOnce(redirectTo('http://127.0.0.1:8931/secret.mp4'));

    await expect(downloadDirectVideo('https://cdn.example.com/clip.mp4', tempDir)).rejects.toThrow(
      /private or loopback/i,
    );

    // Hop 1 was fetched; hop 2 never was.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect into metadata even with the opt-in on', async () => {
    vi.stubEnv('MCP_ALLOW_PRIVATE_URLS', '1');
    fetchSpy.mockResolvedValueOnce(redirectTo('http://169.254.169.254/latest/meta-data/'));

    await expect(downloadDirectVideo('https://cdn.example.com/clip.mp4', tempDir)).rejects.toThrow(
      /metadata endpoint/i,
    );
  });

  it('follows a redirect that stays public', async () => {
    // Proves the redirect loop did not simply break following altogether.
    fetchSpy
      .mockResolvedValueOnce(redirectTo('https://cdn2.example.com/real.mp4'))
      .mockResolvedValueOnce(ok('REDIRECTED-BYTES'));

    const path = await downloadDirectVideo('https://cdn.example.com/clip.mp4', tempDir);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await expect(readFile(path as string, 'utf8')).resolves.toBe('REDIRECTED-BYTES');
  });

  it('resolves a relative Location against the current hop', async () => {
    fetchSpy.mockResolvedValueOnce(redirectTo('/moved/real.mp4')).mockResolvedValueOnce(ok('REL'));

    await downloadDirectVideo('https://cdn.example.com/a/clip.mp4', tempDir);

    expect(fetchSpy).toHaveBeenLastCalledWith(
      'https://cdn.example.com/moved/real.mp4',
      expect.anything(),
    );
  });

  it('gives up on an endless redirect loop', async () => {
    fetchSpy.mockResolvedValue(redirectTo('https://cdn.example.com/loop.mp4'));

    await expect(downloadDirectVideo('https://cdn.example.com/loop.mp4', tempDir)).rejects.toThrow(
      /too many redirects/i,
    );
  });

  it('downloads a private address when the operator opted in', async () => {
    // Without this the suite would pass with the download path fully broken.
    vi.stubEnv('MCP_ALLOW_PRIVATE_URLS', '1');
    fetchSpy.mockResolvedValue(ok('LAN-BYTES'));

    const path = await downloadDirectVideo('http://192.168.1.5/clip.mp4', tempDir);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await expect(readFile(path as string, 'utf8')).resolves.toBe('LAN-BYTES');
  });
});
