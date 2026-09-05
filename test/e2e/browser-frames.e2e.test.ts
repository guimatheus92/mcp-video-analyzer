import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { extractBrowserFrames } from '../../src/processors/browser-frame-extractor.js';
import { cleanupTempDir, createTempDir } from '../../src/utils/temp-files.js';
import { FORMAT_MATRIX, formatClip } from '../helpers/index.js';

/**
 * Outcome test for the browser frame-extraction fallback (strategy 3), gated
 * behind `BROWSER_E2E=1` because it needs a real Chrome/Chromium.
 *
 * Why this exists: `extractBrowserFrames` swallows every browser failure into
 * graceful degradation — `loadPuppeteer()` returns null on an import failure,
 * `.launch(...).catch(() => null)` returns null, a missing `<video>` returns
 * `[]`. So a puppeteer API or behaviour regression surfaces as **zero frames
 * and zero test failures**, which is the same "0 is simultaneously correct and
 * catastrophic" ambiguity that `video-formats.e2e.test.ts` exists to close for
 * containers. Before this file the only test in the browser extractor's suite
 * exercised `generateTimestamps`, a pure function with no puppeteer in it —
 * the actual `launch`/`goto`/`screenshot` path had no coverage at all, which
 * is what made the v0.9.0 puppeteer-core 24→25 major bump unverifiable.
 *
 * Gate semantics deliberately mirror `WHISPER_E2E` (issue #30): flag unset =
 * the suite is visibly skipped (an explicit operator opt-out); flag set and
 * Chrome missing = **FAIL**, never a probe-and-skip. A test that quietly skips
 * itself when its dependency is absent proves nothing on the one machine that
 * matters — CI.
 */
const ENABLED = process.env.BROWSER_E2E === '1';

describe.runIf(ENABLED)('E2E: browser frame extraction (real Chrome, puppeteer-core)', () => {
  let workDir: string;
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    workDir = await createTempDir('browser-e2e-');

    const [mp4] = FORMAT_MATRIX;
    if (!mp4) throw new Error('FORMAT_MATRIX is empty');
    const clip = await formatClip(mp4);
    const clipBytes = readFileSync(clip);

    // Served over loopback HTTP rather than `file://`. Still hermetic — nothing
    // leaves the machine and the clip is generated locally — but it goes
    // through Chrome's real network stack, which is what the production
    // fallback drives, and it is the only way this file covers the SSRF
    // request-interception path added for GHSA-hpmc-4g74-v53v.
    //
    // `file://` is refused outright now, and production never reaches here with
    // one: all four callers return early on `toLocalPath(url) !== null`.
    server = createServer((req, res) => {
      if (req.url === '/clip.mp4') {
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': clipBytes.length });
        return res.end(clipBytes);
      }
      const body =
        req.url === '/blank.html'
          ? '<!doctype html><html><body>no video here</body></html>'
          : `<!doctype html><html><body style="margin:0;background:#000">
<video src="/clip.mp4" preload="auto" muted></video></body></html>`;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Loopback is refused by default; this is the documented operator opt-in,
    // and exercising it here is also what proves it still works end to end
    // with a real browser rather than only in unit tests.
    vi.stubEnv('MCP_ALLOW_PRIVATE_URLS', '1');
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (workDir) await cleanupTempDir(workDir);
  });

  it('refuses a blocked destination rather than degrading to an empty array', async () => {
    // The one assertion here that is about the guard rather than about Chrome.
    // It must reject, not return [] — every other zero-frame outcome in this
    // file is graceful degradation, so a silent [] would make a deliberate
    // refusal indistinguishable from "no frames found".
    vi.stubEnv('MCP_ALLOW_PRIVATE_URLS', '');
    await expect(
      extractBrowserFrames(`${origin}/`, join(workDir, 'blocked'), { timestamps: [1] }),
    ).rejects.toThrow(/private or loopback/i);
    vi.stubEnv('MCP_ALLOW_PRIVATE_URLS', '1');
  });

  it('launches Chrome, seeks the video, and screenshots real pixels', async () => {
    const outDir = join(workDir, 'frames');
    await mkdir(outDir, { recursive: true });

    const frames = await extractBrowserFrames(`${origin}/`, outDir, { timestamps: [1] });

    // The load-bearing assertion. Every failure mode inside
    // extractBrowserFrames degrades to `[]`, so this single check is what
    // separates "puppeteer-core works" from "puppeteer-core silently returned
    // nothing" — including the ESM-import shape, which is exactly what the
    // v25 major changed.
    expect(
      frames.length,
      'zero frames means Chrome failed to launch, the page failed to load, or the ' +
        'screenshot path broke — all of which extractBrowserFrames swallows silently',
    ).toBeGreaterThan(0);

    for (const frame of frames) {
      expect(existsSync(frame.filePath), `${frame.filePath} written`).toBe(true);
      expect(frame.mimeType).toBe('image/jpeg');

      // Decode it: a 0-byte or truncated screenshot would still satisfy
      // existsSync, and "the file is there" is not the same claim as "the
      // browser captured pixels".
      const meta = await sharp(frame.filePath).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.width ?? 0).toBeGreaterThan(0);
      expect(meta.height ?? 0).toBeGreaterThan(0);
    }
  });

  it('degrades to an empty array on a page with no <video>, without throwing', async () => {
    const outDir = join(workDir, 'frames-novideo');
    await mkdir(outDir, { recursive: true });

    // The documented graceful-degradation contract: a page without a <video>
    // is a miss, not an error. Paired with the test above, an empty result can
    // no longer be confused for a broken browser — one asserts non-empty on a
    // good page, this asserts empty on a bad one.
    const frames = await extractBrowserFrames(`${origin}/blank.html`, outDir, {
      timestamps: [1],
      videoLoadTimeout: 3000,
    });
    expect(frames).toEqual([]);
  });
});
