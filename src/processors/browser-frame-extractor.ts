import { join } from 'node:path';
// Type-only: erased at compile time, so it does not turn the deliberately
// dynamic `import('puppeteer-core')` below into a hard startup dependency.
import type { HTTPRequest } from 'puppeteer-core';
import type { IFrameResult } from '../types.js';
import { assertPublicUrl } from '../utils/ssrf-guard.js';
import { formatTimestamp } from './frame-extractor.js';

interface BrowserFrameOptions {
  /** Timestamps in seconds to capture frames at */
  timestamps: number[];
  /** Viewport width for screenshots (default: 1280) */
  width?: number;
  /** Viewport height for screenshots (default: 720) */
  height?: number;
  /** Milliseconds to wait after seeking before capturing (default: 500) */
  seekDelay?: number;
  /** Milliseconds to wait for video element to appear (default: 15000) */
  videoLoadTimeout?: number;
}

/**
 * Schemes a page resolves internally — they never reach the network, so there
 * is no destination to validate. Aborting them would break the fallback
 * outright: MSE video players hand the `<video>` element a `blob:` URL, and
 * that element is the entire point of opening the page.
 */
const PAGE_INTERNAL_SCHEMES: ReadonlySet<string> = new Set(['data:', 'blob:', 'about:']);

/**
 * Whether the browser may issue this request. Fails closed: an unparsable
 * target, an unresolvable host, or any scheme that is neither http(s) nor
 * page-internal is refused.
 *
 * `assertPublicUrl` (not `isBlockedHostLiteral`) because redirects and
 * subresources are exactly where a name that resolves to 10.0.0.1 shows up —
 * a literal-only check there re-opens the hole the pre-flight check closed.
 */
async function isAllowedRequestTarget(url: string): Promise<boolean> {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return false;
  }

  if (PAGE_INTERNAL_SCHEMES.has(protocol)) return true;

  return assertPublicUrl(url).then(
    () => true,
    () => false,
  );
}

// Browser-context scripts (run inside page.evaluate as strings to avoid DOM type issues)
const SETUP_VIDEO_SCRIPT = `(() => {
  const video = document.querySelector('video');
  if (!video) return false;
  video.pause();
  video.dataset.originalStyle = video.getAttribute('style') || '';
  video.style.cssText = 'position:fixed!important;top:0!important;left:0!important;' +
    'width:100vw!important;height:100vh!important;z-index:999999!important;' +
    'object-fit:contain!important;background:black!important;';
  const overlay = document.createElement('div');
  overlay.id = '__mcp_overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;' +
    'background:black;z-index:999998;';
  document.body.appendChild(overlay);
  return true;
})()`;

const CLEANUP_SCRIPT = `(() => {
  const video = document.querySelector('video');
  if (video && video.dataset.originalStyle !== undefined) {
    video.setAttribute('style', video.dataset.originalStyle);
    delete video.dataset.originalStyle;
  }
  const overlay = document.getElementById('__mcp_overlay');
  if (overlay) overlay.remove();
})()`;

function seekScript(timestamp: number, delay: number): string {
  return `new Promise((resolve) => {
    const video = document.querySelector('video');
    if (!video) { resolve(false); return; }
    video.currentTime = ${timestamp};
    video.addEventListener('seeked', () => {
      setTimeout(() => resolve(true), ${delay});
    }, { once: true });
    setTimeout(() => resolve(false), 5000);
  })`;
}

/**
 * Extract frames from a video URL by opening it in a headless browser,
 * seeking the video element to specific timestamps, and taking screenshots.
 *
 * This is a fallback for when yt-dlp + ffmpeg is not available.
 * Requires Chrome/Chromium installed on the system.
 */
export async function extractBrowserFrames(
  url: string,
  outputDir: string,
  options: BrowserFrameOptions,
): Promise<IFrameResult[]> {
  // The second SSRF sink, and the worse of the two: this navigates a real
  // browser, executes the page's JavaScript, and returns what it rendered to
  // the caller as a JPEG — turning blind SSRF into a readable one. Checked
  // before Chrome is even launched.
  await assertPublicUrl(url);

  const puppeteer = await loadPuppeteer();
  if (!puppeteer) {
    return [];
  }

  const width = options.width ?? 1280;
  const height = options.height ?? 720;
  const seekDelay = options.seekDelay ?? 500;
  const videoLoadTimeout = options.videoLoadTimeout ?? 15000;

  const browser = await puppeteer
    .launch({
      headless: true,
      channel: 'chrome',
      args: ['--no-sandbox', '--disable-gpu', `--window-size=${width},${height}`],
      defaultViewport: { width, height },
    })
    .catch(() => null);

  if (!browser) {
    return [];
  }

  try {
    const page = await browser.newPage();

    // `page.goto` follows redirects inside Chrome, so the pre-flight check
    // above only covers the first hop. Interception is what covers the rest —
    // and every subresource the page asks for, which is its own SSRF channel
    // (an <img src="http://10.0.0.1/..."> is a request we made).
    await page.setRequestInterception(true);
    page.on('request', (request: HTTPRequest) => {
      // Async on purpose: the literal check alone cannot see a hostname that
      // merely RESOLVES internal, which is the same bypass the pre-flight
      // `assertPublicUrl` exists to close. Puppeteer keeps the request paused
      // until continue/abort resolves, so awaiting DNS here is safe.
      void (async () => {
        const allowed = await isAllowedRequestTarget(request.url());
        // Both throw when the request was already handled or the page went
        // away. Neither is actionable, and an unhandled rejection out of an
        // event listener takes the whole process down.
        await (allowed ? request.continue() : request.abort('blockedbyclient')).catch(
          () => undefined,
        );
      })();
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait for a <video> element to appear
    const videoFound = await page
      .waitForSelector('video', { timeout: videoLoadTimeout })
      .then(() => true)
      .catch(() => false);

    if (!videoFound) {
      return [];
    }

    // Pause video + make it fill the viewport for clean screenshots
    await page.evaluate(SETUP_VIDEO_SCRIPT);

    const results: IFrameResult[] = [];

    for (const timestamp of options.timestamps) {
      const seeked = await page.evaluate(seekScript(timestamp, seekDelay));

      if (!seeked) continue;

      const filename = `browser_frame_${String(Math.round(timestamp)).padStart(4, '0')}.jpg`;
      const filePath = join(outputDir, filename);

      await page.screenshot({
        path: filePath,
        type: 'jpeg',
        quality: 80,
      });

      results.push({
        time: formatTimestamp(Math.round(timestamp)),
        filePath,
        mimeType: 'image/jpeg',
      });
    }

    // Restore original state
    await page.evaluate(CLEANUP_SCRIPT).catch(() => undefined);

    return results;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/**
 * Generate smart timestamps for frame extraction based on video duration.
 * Distributes frames evenly across the video.
 */
export function generateTimestamps(durationSeconds: number, maxFrames: number): number[] {
  if (durationSeconds <= 0 || maxFrames <= 0) return [];

  const count = Math.min(maxFrames, Math.max(1, Math.floor(durationSeconds / 5)));
  const interval = durationSeconds / (count + 1);
  const timestamps: number[] = [];

  for (let i = 1; i <= count; i++) {
    const ts = Math.round(interval * i);
    if (ts > 0 && ts < durationSeconds) {
      timestamps.push(ts);
    }
  }

  return timestamps;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadPuppeteer(): Promise<any> {
  try {
    return await import('puppeteer-core');
  } catch {
    return null;
  }
}
