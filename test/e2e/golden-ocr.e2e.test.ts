import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAdapters, registerAdapter } from '../../src/adapters/adapter.interface.js';
import { LocalFileAdapter } from '../../src/adapters/local-file.adapter.js';
import { extractFrameAt } from '../../src/processors/frame-extractor.js';
import { ocrFrames } from '../../src/processors/frame-ocr.js';
import { preprocessForOcr } from '../../src/processors/image-optimizer.js';
import { getAnalysis, resolveAnalyzeParams } from '../../src/tools/analyze-core.js';
import { cleanupTempDir, createTempDir, getTempFilePath } from '../../src/utils/temp-files.js';
import {
  BIG_TEXT_LINES,
  DENSE_UI_HEADER,
  DENSE_UI_STATES,
  bigTextClip,
  denseUiClip,
} from '../helpers/index.js';

/**
 * OCR *outcome* tests against golden clips with known text — the assertion
 * class whose absence let the #28 downscale bug survive a 500-test suite for
 * months. Everywhere else in the suite an empty OCR result is valid (graceful
 * degradation); these fixtures are built so that here, empty = FAIL.
 *
 * Real tesseract: the first run downloads traineddata (~15MB, cached in
 * <tmp>/mcp-video-analyzer/tessdata — the Loom e2e already triggers this in CI).
 */

// OCR output is noisy on case/punctuation; compare in a normalized space.
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

describe('E2E: OCR outcome on golden clips (real tesseract)', () => {
  beforeAll(() => {
    clearAdapters();
    registerAdapter(new LocalFileAdapter());
  });

  afterAll(() => {
    clearAdapters();
  });

  beforeEach(() => {
    // Ambient env would neutralize or invert these guards: an exported
    // MCP_FRAME_MAX_WIDTH=native emits source-res frames, making the dense-UI
    // test pass even on pre-#28 code (a guard that cannot fail), while
    // MCP_OCR_PREPROCESS=0 or a low MCP_FRAME_JPEG_QUALITY false-fails
    // correct code near the confidence floor. Same hazard the
    // width-dependent unit suites already stub against.
    vi.stubEnv('MCP_FRAME_MAX_WIDTH', '');
    vi.stubEnv('MCP_FRAME_JPEG_QUALITY', '');
    vi.stubEnv('MCP_OCR_PREPROCESS', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The #28 outcome guard. Pre-fix code OCR'd the 800px downscale: 15px text
  // dropped below Tesseract's resolution, every result fell under
  // MIN_CONFIDENCE, text-aware dedup degraded to the visual hash and the
  // static-layout clip collapsed to one frame. This test fails on all of that.
  //
  // Deliberately restricted to pre-#28 options (no maxWidth): the RED proof
  // copies this file verbatim onto the pre-fix tree.
  it('recovers dense-UI text and keeps a frame per text state (issue #28)', async () => {
    const params = resolveAnalyzeParams({ detail: 'standard', maxFrames: 8, forceRefresh: true });
    const { result, cleanup } = await getAnalysis(await denseUiClip(), params);
    try {
      const ocr = result.ocrResults ?? [];
      expect(ocr.length).toBeGreaterThan(0);

      const allText = norm(ocr.map((r) => r.text).join(' '));
      expect(allText).toContain(norm(DENSE_UI_HEADER));
      for (const state of DENSE_UI_STATES) {
        expect(allText).toContain(norm(state));
      }

      // Measured 92 with the shipped font at source resolution; 70 leaves
      // margin without letting a barely-above-MIN_CONFIDENCE(50) pass.
      expect(Math.max(...ocr.map((r) => r.confidence))).toBeGreaterThanOrEqual(70);

      // Text-aware dedup must keep at least one frame per distinct text state.
      expect(result.frames.length).toBeGreaterThanOrEqual(DENSE_UI_STATES.length);
    } finally {
      await cleanup();
    }
  });

  // Diagnostic control for the test above — 96px text is readable at ANY
  // width, so this passes regardless of which frames OCR reads: on pre-#28
  // code recognition ran on the 800px emitted copies (that asymmetry is the
  // RED proof), on current code it runs on the source-res originals.
  // Dense-UI red + big-text red = OCR stack broken; dense-UI red + big-text
  // green = the downscale regression specifically.
  it('recovers big text regardless of emitted-frame width (control)', async () => {
    const params = resolveAnalyzeParams({ detail: 'standard', forceRefresh: true });
    const { result, cleanup } = await getAnalysis(await bigTextClip(), params);
    try {
      const allText = norm((result.ocrResults ?? []).map((r) => r.text).join(' '));
      for (const line of BIG_TEXT_LINES) {
        expect(allText).toContain(norm(line));
      }
      expect(result.frames.length).toBeGreaterThanOrEqual(BIG_TEXT_LINES.length);
    } finally {
      await cleanup();
    }
  });

  // preprocessForOcr had zero tests before this file: prove the actual OCR
  // preprocessing path (grayscale + 2x upscale + normalize + sharpen) yields
  // an image real tesseract can read above the isMeaningfulOcr floor.
  it('preprocessForOcr output is readable by tesseract above MIN_CONFIDENCE', async () => {
    const tempDir = await createTempDir('golden-ocr-');
    try {
      const frame = await extractFrameAt(await denseUiClip(), tempDir, '0:00');
      const preprocessed = getTempFilePath(tempDir, 'pre_ocr.png');
      await preprocessForOcr(frame.filePath, preprocessed);

      // Disable in-pipeline preprocessing so tesseract reads exactly our output.
      vi.stubEnv('MCP_OCR_PREPROCESS', '0');
      const [ocr] = await ocrFrames([{ ...frame, filePath: preprocessed }], 'eng');

      expect(ocr).toBeDefined();
      expect(norm(ocr.text)).toContain(norm(DENSE_UI_HEADER));
      expect(ocr.confidence).toBeGreaterThan(50);
    } finally {
      // Env restore happens in afterEach; only the temp dir is ours to clean.
      await cleanupTempDir(tempDir);
    }
  });
});
