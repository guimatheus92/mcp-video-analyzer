import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
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
 * across Windows dev machines and ubuntu CI, without system font discovery.
 * drawtext needs libfreetype, which the ffmpeg-static WINDOWS build compiles
 * in but the LINUX build does not ("No such filter: 'drawtext'") — so the CI
 * e2e job installs the distro ffmpeg and points `GOLDEN_FFMPEG` at it for
 * CLIP GENERATION ONLY; everything the production code runs still uses the
 * bundled binary. If drawtext is missing wherever generation runs, ffmpeg
 * exits non-zero and the test FAILS with ffmpeg's error; there is no
 * silent-skip path.
 *
 * Ground-truth strings stay within [A-Z0-9 ] so drawtext needs no escaping.
 */

// Cached clips are keyed by a hash of their full ffmpeg argv (which embeds
// every recipe input: filters, ground-truth strings, font path, sizes,
// durations), so ANY recipe edit self-invalidates — no manual version bump
// for a human to forget, the same hand-maintained-invariant hazard the
// cache-key guard in analyze-core.ts exists to eliminate.
const GOLDEN_DIR = join(tmpdir(), 'mcp-video-analyzer', 'test-golden');

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

/**
 * Ground truth for the committed speech fixture `test/fixtures/speech.wav`
 * (issue #30 — the transcript half of the "empty = FAIL" convention).
 *
 * Provenance: generated once with Windows TTS (System.Speech, voice
 * "Microsoft Zira Desktop", Rate -1) at 16kHz/16-bit/mono — the exact format
 * extractAudioTrack() produces — speaking:
 *
 *   "The quick brown fox jumps over the lazy dog."
 *
 * 3.63s, mean_volume -20.6dB (safely above the -55dB silence gate). Verified
 * at generation time: whisper `tiny` transcribes it verbatim. "jumps" is
 * deliberately absent from the word list — tense drift ("jumped") is the one
 * plausible ASR wobble on this sentence.
 */
export const SPEECH_WORDS = ['quick', 'brown', 'fox', 'lazy', 'dog'];
/** Absolute path to the committed speech WAV. */
export const SPEECH_WAV = join(FIXTURES_DIR, 'speech.wav');

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
 * Generate-at-most-once cache, persisted ACROSS runs (the `existsSync`
 * short-circuit): the cache file name carries a hash of the ffmpeg argv, so a
 * recipe change lands on a new path and regenerates while an unchanged recipe
 * reuses the previous run's clip. Safe under vitest `pool: 'forks'`: workers
 * race to generate, each writes to a pid-unique temp name, first rename wins
 * and losers discard their copy.
 *
 * `args` is the full ffmpeg argv MINUS the output path (appended here) —
 * anything that influences the rendered clip must flow through it.
 */
async function cachedClip(name: string, args: string[]) {
  const recipeHash = createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 8);
  const finalPath = join(GOLDEN_DIR, `${name}-${recipeHash}.mp4`);
  if (existsSync(finalPath)) return finalPath;

  await mkdir(GOLDEN_DIR, { recursive: true });
  const tmpPath = join(GOLDEN_DIR, `${name}-${recipeHash}.${process.pid}.tmp.mp4`);
  // GOLDEN_FFMPEG: generation-only override for environments whose bundled
  // ffmpeg lacks drawtext (the ffmpeg-static linux build — see file header).
  // The binary is not part of the cache key: CI tmpdirs are ephemeral, and a
  // dev machine only ever uses one binary, so cross-binary staleness can't
  // occur in practice.
  await runFfmpeg([...args, tmpPath], process.env.GOLDEN_FFMPEG || undefined);
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
    // Half-open windows: `between` is inclusive on both ends, so at t=i two
    // states would co-draw at the same y and any sample landing exactly on an
    // integer second would only ever see that state garbled.
    ...DENSE_UI_STATES.map((state, i) =>
      textLine(state, 160, { enable: `gte(t,${i})*lt(t,${i + 1})` }),
    ),
  ].join(',');
  return cachedClip('dense-ui', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=0x1e2430:s=1920x1080:d=${DENSE_UI_STATES.length}:r=5`,
    '-vf',
    filters,
    '-pix_fmt',
    'yuv420p',
  ]);
}

/**
 * Control clip for the dense-UI test: the same structure at 96px, which OCRs
 * fine even through the 800px downscale. Diagnostic pair: dense-UI red +
 * big-text red = OCR stack broken; dense-UI red + big-text green = the
 * downscale regression specifically.
 */
export function bigTextClip(): Promise<string> {
  // Half-open windows for the same boundary reason as denseUiClip.
  const filters = BIG_TEXT_LINES.map((line, i) =>
    textLine(line, 300, { size: 96, enable: `gte(t,${i * 2})*lt(t,${i * 2 + 2})` }),
  ).join(',');
  return cachedClip('big-text', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=0x1e2430:s=1280x720:d=${BIG_TEXT_LINES.length * 2}:r=5`,
    '-vf',
    filters,
    '-pix_fmt',
    'yuv420p',
  ]);
}

/**
 * Three solid-color segments with hard cuts at exactly SCENE_CUT_TIMES —
 * ground truth for scene detection (every existing frame-count assertion only
 * bounds against duration; none pins cuts to known timestamps).
 */
export function sceneCutClip(): Promise<string> {
  const seg = (color: string) => `color=c=${color}:s=320x240:d=2:r=10`;
  return cachedClip('scene-cut', [
    '-y',
    ...['red', 'blue', 'green'].flatMap((c) => ['-f', 'lavfi', '-i', seg(c)]),
    '-filter_complex',
    '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map',
    '[v]',
    '-pix_fmt',
    'yuv420p',
  ]);
}

/**
 * The committed speech WAV muxed under a solid-color video — a "video with
 * known speech" for full-pipeline transcript outcome tests (getAnalysis →
 * extractAudioTrack → whisper). No drawtext, so it renders with any ffmpeg.
 */
export async function speechClip(): Promise<string> {
  // The argv only carries the WAV's *path*; hash its content in so a
  // regenerated speech.wav self-invalidates the cached mux like every other
  // recipe input.
  const wavHash = createHash('sha256')
    .update(await readFile(SPEECH_WAV))
    .digest('hex')
    .slice(0, 8);
  return cachedClip('speech', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x1e2430:s=320x240:d=4:r=5',
    '-i',
    SPEECH_WAV,
    '-c:a',
    'aac',
    '-shortest',
    '-pix_fmt',
    'yuv420p',
    '-metadata',
    `comment=speech-${wavHash}`,
  ]);
}
