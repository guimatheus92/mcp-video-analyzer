import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_DIR } from './fixtures.js';
import { runFfmpeg } from './tools.js';

/**
 * Deterministic ffmpeg-generated clips with KNOWN content — the ground truth
 * that outcome tests assert against.
 *
 * Every other fixture in this repo is content-free (solid colors, testsrc,
 * a pure-black clip), which is why the #28 OCR-downscale bug was invisible to
 * a 500-test suite: no test COULD assert "the pipeline recovered the text",
 * so 0 OCR results was simultaneously "working as designed" and "completely
 * broken". These clips make emptiness a failure.
 *
 * Rendering uses the TTF shipped in `test/fixtures/fonts/` (OFL license) with
 * an explicit `fontfile=` — one known font keeps OCR-confidence floors stable
 * across Windows dev machines and ubuntu CI, and needs only libfreetype
 * (compiled into ffmpeg-static), not system font discovery. If drawtext is
 * ever missing, ffmpeg exits non-zero and the test FAILS with ffmpeg's error;
 * there is no silent-skip path.
 *
 * Ground-truth strings stay within [A-Z0-9 ] so drawtext needs no escaping.
 */

// Bump when changing any clip recipe — invalidates the cross-run cache.
const GOLDEN_DIR = join(tmpdir(), 'mcp-video-analyzer', 'test-golden-v1');

/** Static header line, present on every dense-UI frame. */
export const DENSE_UI_HEADER = 'ORDERS DASHBOARD 2026';
/** One per second of the dense-UI clip — only this 15px line changes. */
export const DENSE_UI_STATES = [
  'STATE ALPHA 100',
  'STATE BRAVO 200',
  'STATE CHARLIE 300',
  'STATE DELTA 400',
];
/** Two 2-second states of the big-text control clip. */
export const BIG_TEXT_LINES = ['BIG CONTROL ONE', 'BIG CONTROL TWO'];
/** Hard-cut timestamps (seconds) of the scene-cut clip. */
export const SCENE_CUT_TIMES = [2, 4];

// drawtext filter-option values: '\' -> '/' and 'C:' -> 'C\:' (the drive colon
// would otherwise read as a filter-option separator on Windows).
const FONT_FILE = join(FIXTURES_DIR, 'fonts', 'JetBrainsMono-Regular.ttf')
  .replaceAll('\\', '/')
  .replaceAll(':', '\\:');

function textLine(
  text: string,
  y: number,
  opts: { size?: number; color?: string; enable?: string } = {},
): string {
  const parts = [
    `fontfile=${FONT_FILE}`,
    `text='${text}'`,
    `fontsize=${opts.size ?? 15}`,
    `fontcolor=${opts.color ?? 'white'}`,
    'x=120',
    `y=${y}`,
  ];
  if (opts.enable) parts.push(`enable='${opts.enable}'`);
  return `drawtext=${parts.join(':')}`;
}

/**
 * Generate-once-per-run cache, safe under vitest `pool: 'forks'`: workers race
 * to generate, each writes to a pid-unique temp name, first rename wins and
 * losers discard their copy.
 */
async function cachedClip(name: string, generate: (outPath: string) => Promise<void>) {
  const finalPath = join(GOLDEN_DIR, `${name}.mp4`);
  if (existsSync(finalPath)) return finalPath;

  await mkdir(GOLDEN_DIR, { recursive: true });
  const tmpPath = join(GOLDEN_DIR, `${name}.${process.pid}.tmp.mp4`);
  await generate(tmpPath);
  try {
    await rename(tmpPath, finalPath);
  } catch (e) {
    // Another worker renamed first (Windows rejects rename onto an existing
    // file). Its clip is byte-equivalent by construction; drop ours.
    if (!existsSync(finalPath)) throw e;
    await rm(tmpPath, { force: true });
  }
  return finalPath;
}

/**
 * The #28 repro: 1920x1080 dense-UI screencast — static layout, 15px text,
 * one line changing per second. At the default 800px emitted width this text
 * is unreadable to Tesseract; at source resolution it OCRs at confidence ~90.
 * Scene detection scores ~0 (a one-line text change on 1080p), so extraction
 * falls back to uniform sampling and text-aware dedup is what must keep one
 * frame per state.
 */
export function denseUiClip(): Promise<string> {
  const filters = [
    textLine(DENSE_UI_HEADER, 40),
    textLine('CPU 42 MEM 71 NET 208', 70, { color: '0xaaaaaa' }),
    textLine('REGION US EAST 1 PROD', 100, { color: '0x9cdcfe' }),
    ...DENSE_UI_STATES.map((state, i) =>
      textLine(state, 160, { enable: `between(t,${i},${i + 1})` }),
    ),
  ].join(',');
  return cachedClip('dense-ui', (out) =>
    runFfmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=0x1e2430:s=1920x1080:d=${DENSE_UI_STATES.length}:r=5`,
      '-vf',
      filters,
      '-pix_fmt',
      'yuv420p',
      out,
    ]),
  );
}

/**
 * Control clip for the dense-UI test: the same structure at 96px, which OCRs
 * fine even through the 800px downscale. Diagnostic pair: dense-UI red +
 * big-text red = OCR stack broken; dense-UI red + big-text green = the
 * downscale regression specifically.
 */
export function bigTextClip(): Promise<string> {
  const filters = BIG_TEXT_LINES.map((line, i) =>
    textLine(line, 300, { size: 96, enable: `between(t,${i * 2},${i * 2 + 2})` }),
  ).join(',');
  return cachedClip('big-text', (out) =>
    runFfmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=0x1e2430:s=1280x720:d=${BIG_TEXT_LINES.length * 2}:r=5`,
      '-vf',
      filters,
      '-pix_fmt',
      'yuv420p',
      out,
    ]),
  );
}

/**
 * Three solid-color segments with hard cuts at exactly SCENE_CUT_TIMES —
 * ground truth for scene detection (every existing frame-count assertion only
 * bounds against duration; none pins cuts to known timestamps).
 */
export function sceneCutClip(): Promise<string> {
  const seg = (color: string) => `color=c=${color}:s=320x240:d=2:r=10`;
  return cachedClip('scene-cut', (out) =>
    runFfmpeg([
      '-y',
      ...['red', 'blue', 'green'].flatMap((c) => ['-f', 'lavfi', '-i', seg(c)]),
      '-filter_complex',
      '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
      '-map',
      '[v]',
      '-pix_fmt',
      'yuv420p',
      out,
    ]),
  );
}
