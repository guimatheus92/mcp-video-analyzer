import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  let pageUrl: string;

  beforeAll(async () => {
    workDir = await createTempDir('browser-e2e-');

    // A local page embedding a real generated clip. `file://` keeps this
    // hermetic — no network, no third-party video, and the same <video>
    // element shape the production fallback drives on a platform page.
    const [mp4] = FORMAT_MATRIX;
    if (!mp4) throw new Error('FORMAT_MATRIX is empty');
    const clip = await formatClip(mp4);
    const html = `<!doctype html>
<html><body style="margin:0;background:#000">
<video src="${pathToFileURL(clip).href}" preload="auto" muted></video>
</body></html>`;
    const htmlPath = join(workDir, 'page.html');
    await writeFile(htmlPath, html, 'utf8');
    pageUrl = pathToFileURL(htmlPath).href;
  });

  afterAll(async () => {
    if (workDir) await cleanupTempDir(workDir);
  });

  it('launches Chrome, seeks the video, and screenshots real pixels', async () => {
    const outDir = join(workDir, 'frames');
    await mkdir(outDir, { recursive: true });

    const frames = await extractBrowserFrames(pageUrl, outDir, { timestamps: [1] });

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
    const blankPath = join(workDir, 'blank.html');
    await writeFile(blankPath, '<!doctype html><html><body>no video here</body></html>', 'utf8');

    // The documented graceful-degradation contract: a page without a <video>
    // is a miss, not an error. Paired with the test above, an empty result can
    // no longer be confused for a broken browser — one asserts non-empty on a
    // good page, this asserts empty on a bad one.
    const frames = await extractBrowserFrames(pathToFileURL(blankPath).href, outDir, {
      timestamps: [1],
      videoLoadTimeout: 3000,
    });
    expect(frames).toEqual([]);
  });
});
