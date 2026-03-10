/**
 * Generate example outputs by running all tools against the Loom demo video.
 *
 * Usage: npx tsx examples/generate.ts
 *
 * This downloads the video, runs every tool, and saves JSON + frames
 * into examples/loom-demo/. Committed outputs serve as documentation
 * and regression baselines.
 */

import { writeFile, mkdir, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);
import { registerAdapter, clearAdapters, getAdapter } from '../src/adapters/adapter.interface.js';
import { DirectAdapter } from '../src/adapters/direct.adapter.js';
import { LoomAdapter } from '../src/adapters/loom.adapter.js';
import {
  extractSceneFrames,
  extractDenseFrames,
  extractFrameBurst,
  probeVideoDuration,
} from '../src/processors/frame-extractor.js';
import { optimizeFrames } from '../src/processors/image-optimizer.js';
import { deduplicateFrames } from '../src/processors/frame-dedup.js';
import { buildAnnotatedTimeline } from '../src/processors/annotated-timeline.js';
import { getDetailConfig } from '../src/config/detail-levels.js';
import { createTempDir, cleanupTempDir } from '../src/utils/temp-files.js';

const LOOM_URL = 'https://www.loom.com/share/bdebdfe44b294225ac718bad241a94fe';
const OUT_DIR = join(import.meta.dirname ?? '.', 'loom-demo');
const FRAMES_DIR = join(OUT_DIR, 'frames');

async function saveJson(name: string, data: unknown) {
  await writeFile(join(OUT_DIR, `${name}.json`), JSON.stringify(data, null, 2) + '\n');
  console.log(`  ✓ ${name}.json`);
}

async function main() {
  clearAdapters();
  registerAdapter(new LoomAdapter());
  registerAdapter(new DirectAdapter());

  await mkdir(FRAMES_DIR, { recursive: true });

  const adapter = getAdapter(LOOM_URL);
  console.log('Adapter:', adapter.name);

  // ── Metadata ──
  console.log('\n📋 Fetching metadata...');
  const metadata = await adapter.getMetadata(LOOM_URL);
  await saveJson('metadata', metadata);

  // ── Transcript ──
  console.log('\n📝 Fetching transcript...');
  const transcript = await adapter.getTranscript(LOOM_URL);
  await saveJson('transcript', transcript);

  // ── Comments & Chapters ──
  console.log('\n💬 Fetching comments & chapters...');
  const [comments, chapters, aiSummary] = await Promise.all([
    adapter.getComments(LOOM_URL),
    adapter.getChapters(LOOM_URL),
    adapter.getAiSummary(LOOM_URL),
  ]);
  await saveJson('comments', comments);
  await saveJson('chapters', chapters);
  await saveJson('ai-summary', aiSummary);

  // ── Download video for frame extraction ──
  console.log('\n🎬 Downloading video...');
  const tempDir = await createTempDir('example-gen-');
  try {
    // Use yt-dlp directly since the adapter may fail on DASH streams
    let videoPath = await adapter.downloadVideo(LOOM_URL, tempDir);
    if (!videoPath) {
      console.log('  Adapter download failed, trying yt-dlp directly...');
      const outPath = join(tempDir, 'loom_video.%(ext)s');
      try {
        await execFileAsync('yt-dlp', ['-o', outPath, '--no-warnings', '-q', LOOM_URL], {
          timeout: 120000,
        });
        // Find whatever file yt-dlp created
        const { stdout } = await execFileAsync('yt-dlp', ['--print', 'filename', '-o', outPath, LOOM_URL]);
        const actualPath = stdout.trim();
        if (existsSync(actualPath)) videoPath = actualPath;
      } catch (e) {
        console.log('  ⚠ yt-dlp failed:', (e as Error).message);
      }
    }
    if (!videoPath) {
      console.log('  ⚠ Could not download video — skipping frame extraction');
      return;
    }
    console.log('  ✓ Downloaded:', videoPath);

    const duration = await probeVideoDuration(videoPath);
    console.log(`  Duration: ${duration.toFixed(1)}s`);

    // ── Scene-change frames (standard detail) ──
    console.log('\n🖼️  Extracting scene-change frames (standard)...');
    const stdConfig = getDetailConfig('standard');
    const sceneFrames = await extractSceneFrames(videoPath, tempDir, {
      threshold: 0.05,
      maxFrames: stdConfig.maxFrames,
    });
    console.log(`  ${sceneFrames.length} scene frames detected`);

    // Optimize
    const optimizedPaths = await optimizeFrames(
      sceneFrames.map((f) => f.filePath),
      tempDir,
    );
    const optimizedFrames = sceneFrames.map((f, i) => ({
      ...f,
      filePath: optimizedPaths[i] ?? f.filePath,
    }));

    // Dedup
    const dedupedFrames = await deduplicateFrames(optimizedFrames);
    console.log(`  ${dedupedFrames.length} after deduplication`);

    // Copy frames to examples dir
    const framesMeta = [];
    for (let i = 0; i < dedupedFrames.length; i++) {
      const frame = dedupedFrames[i]!;
      const filename = `scene_${String(i + 1).padStart(3, '0')}.jpg`;
      await copyFile(frame.filePath, join(FRAMES_DIR, filename));
      framesMeta.push({
        filename,
        time: frame.time,
        mimeType: frame.mimeType,
      });
    }
    await saveJson('frames-scene', framesMeta);

    // ── Dense frames (detailed) ──
    console.log('\n🔍 Extracting dense frames (detailed, 1fps)...');
    const detConfig = getDetailConfig('detailed');
    const denseFrames = await extractDenseFrames(videoPath, tempDir, {
      maxFrames: detConfig.maxFrames,
    });
    console.log(`  ${denseFrames.length} dense frames`);
    // Save every 10th dense frame as a sample (6 frames from 60)
    const denseSample = denseFrames.filter((_, i) => i % 10 === 0);
    const denseMeta = [];
    for (let i = 0; i < denseSample.length; i++) {
      const frame = denseSample[i]!;
      const filename = `dense_${String(i + 1).padStart(3, '0')}.jpg`;
      const optimized = await optimizeFrames([frame.filePath], tempDir);
      await copyFile(optimized[0] ?? frame.filePath, join(FRAMES_DIR, filename));
      denseMeta.push({ filename, time: frame.time, mimeType: frame.mimeType });
    }
    await saveJson('frames-dense-summary', {
      totalCount: denseFrames.length,
      savedSamples: denseMeta.length,
      maxFrames: detConfig.maxFrames,
      duration,
      firstTime: denseFrames[0]?.time,
      lastTime: denseFrames[denseFrames.length - 1]?.time,
      samples: denseMeta,
    });

    // ── Burst frames (moment analysis 0:30–0:45) ──
    console.log('\n⏱️  Extracting burst frames (0:30–0:45)...');
    const burstFrames = await extractFrameBurst(videoPath, tempDir, '0:30', '0:45', 10);
    console.log(`  ${burstFrames.length} burst frames`);
    const burstMeta = [];
    for (let i = 0; i < burstFrames.length; i++) {
      const frame = burstFrames[i]!;
      const filename = `burst_${String(i + 1).padStart(3, '0')}.jpg`;
      await copyFile(frame.filePath, join(FRAMES_DIR, filename));
      burstMeta.push({ filename, time: frame.time, mimeType: frame.mimeType });
    }
    await saveJson('frames-burst', burstMeta);

    // ── OCR on best available frames ──
    const ocrSourceFrames = dedupedFrames.length > 0 ? dedupedFrames : denseSample;
    // OCR skipped in generator — tesseract.js worker crashes on Node 24.
    // In production, OCR runs fine via the MCP tool (different process model).
    console.log(`\n🔤 OCR: skipped (${ocrSourceFrames.length} frames available for OCR in production)`);
    const ocrResults = ocrSourceFrames.map((_f, i) => ({
      file: dedupedFrames.length > 0 ? `scene_${String(i + 1).padStart(3, '0')}.jpg` : `dense_${String(i + 1).padStart(3, '0')}.jpg`,
      text: '(skipped in generator — tesseract.js crashes on Node 24)',
    }));
    await saveJson('ocr-results', ocrResults);

    // ── Annotated timeline ──
    console.log('\n📊 Building annotated timeline...');
    // Build timeline from frames + transcript (OCR skipped, so pass empty)
    const timeline = buildAnnotatedTimeline(
      ocrSourceFrames.map((f) => ({ time: f.time })),
      transcript as { time: string; text: string }[],
      [],
    );
    await saveJson('timeline', timeline);
    console.log(`  ${timeline.length} timeline entries`);

    // ── Moment analysis transcript segment ──
    console.log('\n🎯 Filtering transcript for moment (0:30–0:45)...');
    const fromSeconds = 30;
    const toSeconds = 45;
    const momentTranscript = transcript.filter((entry) => {
      const parts = entry.time.split(':').map(Number);
      const seconds = parts.length === 3
        ? (parts[0]! * 3600 + parts[1]! * 60 + parts[2]!)
        : parts.length === 2
          ? (parts[0]! * 60 + parts[1]!)
          : parts[0]!;
      return seconds >= fromSeconds && seconds <= toSeconds;
    });
    await saveJson('moment-transcript-0m30s-0m45s', momentTranscript);
    console.log(`  ${momentTranscript.length} transcript entries in range`);

    // ── Full analysis result (what analyze_video returns) ──
    console.log('\n📦 Saving full analysis result...');
    await saveJson('full-analysis', {
      url: LOOM_URL,
      detail: 'standard',
      metadata,
      transcript,
      comments,
      chapters,
      aiSummary,
      frames: framesMeta,
      ocrResults,
      timeline,
      warnings: [],
    });

    console.log('\n✅ All outputs saved to examples/loom-demo/');
    console.log(`   ${dedupedFrames.length + denseSample.length + burstFrames.length} frame images in examples/loom-demo/frames/`);
  } finally {
    await cleanupTempDir(tempDir);
  }
}

main().catch((err) => {
  console.error('Generation failed:', err);
  process.exit(1);
});
