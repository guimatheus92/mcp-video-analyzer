import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAdapters, registerAdapter } from '../../src/adapters/adapter.interface.js';
import { LocalFileAdapter } from '../../src/adapters/local-file.adapter.js';
import {
  extractKeyFrames,
  probeVideo,
  probeVideoDuration,
} from '../../src/processors/frame-extractor.js';
import { registerAnalyzeVideo } from '../../src/tools/analyze-video.js';
import { cleanupTempDir, createTempDir } from '../../src/utils/temp-files.js';
import { VIDEO_EXTENSIONS, detectPlatform } from '../../src/utils/url-detector.js';
import {
  FORMAT_CLIP_SECONDS,
  FORMAT_MATRIX,
  captureToolExecute,
  formatClip,
  frameCountOf,
  imageWidths,
  noProgress,
  portraitClip,
  warningsOf,
} from '../helpers/index.js';

/**
 * Decode-outcome tests across every container this server accepts.
 *
 * Before this file, `VIDEO_EXTENSIONS` listed 14 containers that reach ffmpeg
 * in production while only mp4/h264 was genuinely exercised (plus the one
 * webm/vp9 probe added by #24). The other twelve were covered by *string*
 * assertions in `url-detector.test.ts` — the extension was checked, no file was
 * ever opened. A codec the bundled ffmpeg-static build could not decode would
 * have produced zero frames and zero test failures, because "0 frames" is a
 * legitimate graceful-degradation outcome everywhere else in this suite.
 *
 * Every clip here is a MOVING `testsrc` pattern with a real audio track, so
 * empty is never valid: 0 frames = FAIL. Same "empty must be able to fail" rule
 * the golden OCR and transcription fixtures exist to satisfy (CLAUDE.md →
 * Testing conventions).
 *
 * No drawtext — clips come from the bundled binary — so this file needs
 * neither `GOLDEN_FFMPEG` nor a runner with a distro ffmpeg. It is not fully
 * offline, though: `detail: 'standard'` always runs OCR
 * (`DETAIL_CONFIGS.standard.includeOcr`), so tesseract.js fetches eng+por
 * traineddata (~7MB) once on a cold `cachePath`. That single cacheable request
 * to a stable endpoint is why `npm run test:formats` can also run on the
 * Windows CI job (which caches tessdata), while the rest of the e2e suite —
 * which downloads real third-party videos on every run — stays ubuntu-only.
 */
describe('E2E: video format matrix (real ffmpeg decode)', () => {
  beforeAll(() => {
    clearAdapters();
    registerAdapter(new LocalFileAdapter());
  });

  afterAll(() => {
    clearAdapters();
  });

  beforeEach(() => {
    // MCP_WRITE_SIDECARS is the load-bearing stub. Clips are cached in the OS
    // tmpdir ACROSS runs, so with sidecars enabled the first run would write
    // <clip>.analysis.json beside each clip and every later run would replay
    // it — ffmpeg never invoked, assertions green, decoding entirely unproven.
    // A test that cannot fail is worse than no test.
    vi.stubEnv('MCP_WRITE_SIDECARS', '');
    // The width/quality/preprocess trio for the same reason as golden-ocr:
    // ambient values move the emitted frames out from under the assertions.
    vi.stubEnv('MCP_FRAME_MAX_WIDTH', '');
    vi.stubEnv('MCP_FRAME_JPEG_QUALITY', '');
    vi.stubEnv('MCP_OCR_PREPROCESS', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * Does the BUNDLED binary crash on this container?
   *
   * The linux `ffmpeg-static` 7.0.2 build segfaults in the MPEG-TS demuxer:
   * `.mts`/`.m2ts` (the standard AVCHD camcorder format) kill ffmpeg on probe,
   * extract, and even remux, while the byte-identical file parses fine on the
   * Windows build. That is a real defect in the published Docker image, not a
   * test artifact — so this matrix neither skips those rows nor pretends
   * frames come back.
   *
   * The capability is PROBED, never inferred from `process.platform`: the
   * question is what this binary does, and a platform check is a guess about a
   * binary rather than a fact about it. It would also silently stop being true
   * the day ffmpeg-static ships a fixed build.
   */
  async function demuxerCrashes(clip: string): Promise<boolean> {
    try {
      await probeVideoDuration(clip);
      return false;
    } catch (e) {
      // Only a SIGNAL death counts. Any other probe failure is a genuine bug
      // and must propagate — this must not become a catch-all that turns real
      // regressions into "known broken".
      if (e instanceof Error && /crashed \(SIG/.test(e.message)) return true;
      throw e;
    }
  }

  describe.each(FORMAT_MATRIX)('$ext ($videoCodec / $audioCodec)', (format) => {
    it('routes, probes, decodes frames, and exposes its audio track', async () => {
      const clip = await formatClip(format);

      // 1. The extension actually routes to a video source. A container listed
      //    in VIDEO_EXTENSIONS that detectPlatform rejects is unreachable.
      expect(detectPlatform(clip)).toBe('local');

      if (await demuxerCrashes(clip)) {
        // The contract for a container the bundled binary cannot read: the
        // failure must be LEGIBLE. A zero-frame result with no explanation is
        // still a failure here — that silent-empty outcome is the entire
        // reason this file exists.
        const dir = await createTempDir('fmt-crash-');
        try {
          const { frames, warnings } = await extractKeyFrames(clip, dir, { maxFrames: 3 });
          expect(frames.length, `${format.ext} crashes the demuxer, so no frames`).toBe(0);
          expect(
            warnings.some((w) => /crashed \(SIG/.test(w)),
            `${format.ext} must report the crash, not return an unexplained empty result. ` +
              `Got: ${JSON.stringify(warnings)}`,
          ).toBe(true);
          // And it must not leak the ffmpeg command line (CLAUDE.md).
          expect(warnings.some((w) => w.includes('-vf') || w.includes('ffmpeg -i'))).toBe(false);
        } finally {
          await cleanupTempDir(dir);
        }
        return;
      }

      // 2. Duration parses out of ffmpeg's stderr for THIS container. asf,
      //    mpeg and flv print a different header shape than mp4, and
      //    parseDurationFromStderr has to cope with all of them.
      const duration = await probeVideoDuration(clip);
      expect(duration).toBeGreaterThan(FORMAT_CLIP_SECONDS * 0.5);
      expect(duration).toBeLessThan(FORMAT_CLIP_SECONDS * 3);

      // 3. The codec genuinely decodes. testsrc is non-black, so black-frame
      //    filtering cannot legitimately empty this: 0 frames means the bundled
      //    build cannot decode this stream.
      const dir = await createTempDir('fmt-');
      try {
        const { frames, warnings } = await extractKeyFrames(clip, dir, { maxFrames: 3 });
        expect(frames.length, `decoded frames for ${format.ext}`).toBeGreaterThan(0);
        // Not a blanket "no warnings" check: extractKeyFrames legitimately
        // reports the uniform-sampling fallback here (testsrc has no hard
        // cuts). Only the extraction-failure warnings matter.
        expect(
          warnings.filter((w) => /extraction failed/i.test(w)),
          `extraction failures for ${format.ext}`,
        ).toEqual([]);
      } finally {
        await cleanupTempDir(dir);
      }

      // 4. The audio track survives the mux/demux round trip. Transcription
      //    reads this: a container whose audio ffmpeg cannot see yields an
      //    empty transcript, indistinguishable from a genuinely silent video.
      const probe = await probeVideo(clip);
      expect(probe.hasAudio, `hasAudio for ${format.ext}`).toBe(true);
      expect(probe.audioCodec, `audioCodec for ${format.ext}`).toBeTruthy();
    });

    it('analyze_video returns frames through the MCP tool surface', async () => {
      const clip = await formatClip(format);
      const execute = captureToolExecute(registerAnalyzeVideo);

      const result = await execute(
        { url: clip, options: { detail: 'standard', maxFrames: 2, forceRefresh: true } },
        noProgress,
      );

      if (await demuxerCrashes(clip)) {
        // Same contract at the tool surface: zero frames is acceptable ONLY
        // when the tool says why. An MCP client that gets `frameCount: 0` and
        // no warning cannot tell a crashed demuxer from an empty video.
        expect(frameCountOf(result)).toBe(0);
        expect(
          warningsOf(result).some((w) => /crashed \(SIG/.test(w)),
          `analyze_video must surface the crash for ${format.ext}. ` +
            `Got: ${JSON.stringify(warningsOf(result))}`,
        ).toBe(true);
        return;
      }

      // The processor assertion above proves ffmpeg can decode the file; this
      // proves the whole tool path does — adapter routing, the analysis
      // pipeline, frame emission, and the JSON contract a client parses.
      expect(frameCountOf(result), `frameCount for ${format.ext}`).toBeGreaterThan(0);

      // Positive proof that the AUDIO half of this container demuxed, end to
      // end. Every clip carries an anullsrc track, so the silence gate firing
      // means extractAudioTrack pulled real audio out of THIS container and
      // volumedetect measured it. A container whose audio ffmpeg cannot see
      // produces the same empty transcript with this warning absent — which
      // is precisely the ambiguity a "transcript is empty" assertion could
      // never distinguish.
      expect(
        warningsOf(result).filter((w) => /Audio track is silent/i.test(w)),
        `silence-gate warning for ${format.ext} (proves the audio track demuxed)`,
      ).toHaveLength(1);
    });
  });

  /**
   * Drift guard. Without it, adding an extension to VIDEO_EXTENSIONS ships an
   * untested container and nothing says so — the exact failure mode this file
   * exists to close.
   *
   * The prove-it-scanned-something assertions come first: a guard that silently
   * passes when both sets are empty is the scan-style anti-pattern CLAUDE.md
   * bans.
   */
  describe('coverage drift guard', () => {
    // Extensions deliberately NOT decoded here, each with its reason. Empty
    // today — the matrix covers all 14. Any entry added here must say why.
    const DOCUMENTED_EXCLUSIONS = new Map<string, string>();

    it('decodes every extension in VIDEO_EXTENSIONS', () => {
      expect(VIDEO_EXTENSIONS.size).toBeGreaterThanOrEqual(14);
      expect(FORMAT_MATRIX.length).toBeGreaterThanOrEqual(VIDEO_EXTENSIONS.size);

      const covered = new Set(FORMAT_MATRIX.map((f) => f.ext));
      const uncovered = [...VIDEO_EXTENSIONS].filter(
        (ext) => !covered.has(ext) && !DOCUMENTED_EXCLUSIONS.has(ext),
      );

      expect(
        uncovered,
        'extensions in VIDEO_EXTENSIONS with no decode test and no documented exclusion',
      ).toEqual([]);
    });

    it('has no matrix rows for containers the server would reject', () => {
      const stray = FORMAT_MATRIX.map((f) => f.ext).filter((ext) => !VIDEO_EXTENSIONS.has(ext));
      expect(stray, 'matrix rows for containers detectPlatform does not accept').toEqual([]);
    });
  });

  /**
   * Negative control. The matrix above claims "0 frames = FAIL"; this proves
   * that claim can actually fire, by running the same assertions against a file
   * that routes exactly like a real clip but cannot be decoded.
   *
   * The repo's own convention is that this proof belongs in the suite, not in a
   * PR description — a guard verified once by hand drifts the moment the code
   * under it changes.
   */
  describe('negative control', () => {
    it('fails the matrix assertions for a routable but undecodable container', async () => {
      const dir = await createTempDir('fmt-neg-');
      try {
        // Valid extension, garbage bytes: detectPlatform accepts it, so the
        // routing assertion passes and only the DECODE assertions can catch it.
        const bad = join(dir, 'undecodable.mp4');
        await writeFile(bad, Buffer.alloc(4096, 0x41));
        expect(detectPlatform(bad)).toBe('local');

        // probeVideoDuration throws when ffmpeg cannot open the input, so the
        // matrix's duration assertion is reached as an error, not a wrong pass.
        await expect(probeVideoDuration(bad)).rejects.toThrow();

        // And extraction yields nothing, so `frames.length > 0` would fail too.
        const out = join(dir, 'frames');
        await mkdir(out, { recursive: true });
        const { frames } = await extractKeyFrames(bad, out, { maxFrames: 3 });
        expect(frames.length, 'an undecodable file must not yield frames').toBe(0);
      } finally {
        await cleanupTempDir(dir);
      }
    });
  });

  /**
   * Portrait/vertical source — the Reels/Stories shape, a documented primary
   * use case with no decode coverage until now. Aspect handling is where a
   * resize regression hides: capping a 1080x1920 source by WIDTH is a different
   * branch from capping a landscape one, and the failure is silent (frames
   * still come back, just wrong).
   */
  describe('portrait source', () => {
    it('extracts frames and caps a vertical frame by width, not height', async () => {
      const clip = await portraitClip();
      const execute = captureToolExecute(registerAnalyzeVideo);

      const result = await execute(
        { url: clip, options: { detail: 'standard', maxFrames: 2, forceRefresh: true } },
        noProgress,
      );

      expect(frameCountOf(result)).toBeGreaterThan(0);

      // Default cap is 800px WIDE. A 1080x1920 source must come back 800 wide
      // (1422 tall) — not 800 tall, and not passed through at 1080.
      const widths = await imageWidths(result);
      expect(widths.length).toBeGreaterThan(0);
      for (const width of widths) {
        expect(width).toBe(800);
      }
    });
  });
});
