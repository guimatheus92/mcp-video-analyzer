import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type * as Puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { clearAdapters, registerAdapter } from '../../src/adapters/adapter.interface.js';
import { DirectAdapter } from '../../src/adapters/direct.adapter.js';
import { LocalFileAdapter } from '../../src/adapters/local-file.adapter.js';
import { extractBrowserFrames } from '../../src/processors/browser-frame-extractor.js';
import { extractFrameBurst, parseTimestamp } from '../../src/processors/frame-extractor.js';
import { registerGetFrameBurst } from '../../src/tools/get-frame-burst.js';
import { cleanupTempDir, createTempDir } from '../../src/utils/temp-files.js';
import { frameIndex, timingClip } from '../helpers/timing-clip.js';
import { captureToolExecute, frameTimingsOf, noProgress, runFfmpeg } from '../helpers/tools.js';

// Only the executable selection changes; navigation, seeking and pixels are real.
vi.mock('puppeteer-core', async (importOriginal) => {
  const actual = await importOriginal<typeof Puppeteer>();
  return {
    ...actual,
    launch: (options: Parameters<typeof actual.launch>[0]) =>
      actual.launch(
        process.env.BROWSER_EXECUTABLE_PATH
          ? { ...options, channel: undefined, executablePath: process.env.BROWSER_EXECUTABLE_PATH }
          : options,
      ),
  };
});

let dir: string;
let video: string;
beforeAll(async () => {
  dir = await createTempDir('burst-timing-');
  video = await timingClip(join(dir, 'source'));
});
afterAll(async () => {
  if (dir) await cleanupTempDir(dir);
});

it('labels burst images with the source time represented by their pixels', async () => {
  const out = join(dir, 'ffmpeg');
  await mkdir(out);
  const frames = await extractFrameBurst(video, out, '0:01', '0:02', 5);
  const indices = await Promise.all(frames.map((frame) => frameIndex(frame.filePath)));
  const times = frames.map((frame) => parseTimestamp(frame.time));
  expect(frames).toHaveLength(5);
  expect(frames.map((frame) => frame.timingOrigin)).toEqual(Array(5).fill('source-pts'));
  for (let i = 0; i < frames.length; i++) expect(times[i]).toBeCloseTo(indices[i] / 10, 3);
});

it('keeps actual source times for a fractional start between frames', async () => {
  const out = join(dir, 'fractional');
  await mkdir(out);
  const frames = await extractFrameBurst(video, out, '0:01.05', '0:01.75', 4);
  const indices = await Promise.all(frames.map((frame) => frameIndex(frame.filePath)));
  expect(indices).toEqual([11, 13, 14, 16]);
  expect(frames.map((frame) => parseTimestamp(frame.time))).toEqual(indices.map((i) => i / 10));
});

it('isolates repeated bursts in the same output directory', async () => {
  const out = join(dir, 'repeated');
  await mkdir(out);
  const first = await extractFrameBurst(video, out, '0:01', '0:02', 5);
  const second = await extractFrameBurst(video, out, '0:02', '0:02.3', 30);
  expect(await Promise.all(first.map((f) => frameIndex(f.filePath)))).toEqual([10, 12, 14, 16, 18]);
  expect(await Promise.all(second.map((f) => frameIndex(f.filePath)))).toEqual([20, 21, 22]);
  expect(await extractFrameBurst(video, out, '0:09', '0:10', 5)).toEqual([]);
});

it('does not duplicate source frames when the requested rate exceeds the source rate', async () => {
  const out = join(dir, 'high-rate');
  await mkdir(out);
  const frames = await extractFrameBurst(video, out, '0:01', '0:01.3', 30);
  expect(await Promise.all(frames.map((frame) => frameIndex(frame.filePath)))).toEqual([
    10, 11, 12,
  ]);
  expect(frames.map((frame) => parseTimestamp(frame.time))).toEqual([1, 1.1, 1.2]);
});

it('reports source PTS across variable-frame-rate gaps', async () => {
  const vfr = join(dir, 'vfr.mp4');
  await runFfmpeg([
    '-y',
    '-i',
    video,
    '-vf',
    "select='eq(n,0)+eq(n,10)+eq(n,11)+eq(n,18)+eq(n,20)+eq(n,29)'",
    '-fps_mode',
    'vfr',
    '-c:v',
    'libx264',
    '-crf',
    '0',
    vfr,
  ]);
  const out = join(dir, 'vfr');
  await mkdir(out);
  const frames = await extractFrameBurst(vfr, out, '0:01.05', '0:02.1', 4);
  const indices = await Promise.all(frames.map((frame) => frameIndex(frame.filePath)));
  expect(indices).toEqual([11, 18, 20]);
  expect(frames.map((frame) => parseTimestamp(frame.time))).toEqual(indices.map((i) => i / 10));
});

it('uses the video-relative timeline when the stream starts at a nonzero PTS', async () => {
  const shifted = join(dir, 'shifted.mp4');
  await runFfmpeg(['-y', '-i', video, '-c', 'copy', '-output_ts_offset', '5', shifted]);
  const out = join(dir, 'shifted');
  await mkdir(out);
  const frames = await extractFrameBurst(shifted, out, '0:01', '0:02', 5);
  expect(await Promise.all(frames.map((frame) => frameIndex(frame.filePath)))).toEqual([
    10, 12, 14, 16, 18,
  ]);
  expect(frames.map((frame) => parseTimestamp(frame.time))).toEqual([1, 1.2, 1.4, 1.6, 1.8]);
});

it.each([
  { to: '0:02', count: 5, indices: [10, 12, 14, 16, 18] },
  { to: '0:01.3', count: 30, indices: [10, 11, 12] },
])(
  'sends timing metadata matching every emitted image ($count requested)',
  async ({ to, count, indices }) => {
    clearAdapters();
    registerAdapter(new LocalFileAdapter());
    try {
      const result = await captureToolExecute(registerGetFrameBurst)(
        { url: video, from: '0:01', to, count, maxWidth: 320 },
        noProgress,
      );
      const images = result.content.filter((c) => c.type === 'image');
      expect(
        await Promise.all(images.map((c) => frameIndex(Buffer.from(c.data ?? '', 'base64')))),
      ).toEqual(indices);
      expect(frameTimingsOf(result)).toEqual(
        indices.map((i) => ({
          time: i === 10 ? '0:01' : `0:01.${i - 10}`,
          timingOrigin: 'source-pts',
        })),
      );
    } finally {
      clearAdapters();
    }
  },
);

describe.runIf(process.env.BROWSER_E2E === '1' || !!process.env.BROWSER_EXECUTABLE_PATH)(
  'real browser fractional burst',
  () => {
    let server: Server;
    let origin: string;
    beforeAll(async () => {
      const bytes = readFileSync(video);
      server = createServer((req, res) => {
        if (req.url === '/clip.mp4') {
          const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
          const start = range ? Number(range[1]) : 0;
          const end = range?.[2] ? Number(range[2]) : bytes.length - 1;
          res.writeHead(range ? 206 : 200, {
            'content-type': 'video/mp4',
            'accept-ranges': 'bytes',
            'content-length': end - start + 1,
            ...(range ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}),
          });
          res.end(bytes.subarray(start, end + 1));
        } else {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<!doctype html><video src="/clip.mp4" preload="auto" muted></video>');
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      vi.stubEnv('MCP_ALLOW_PRIVATE_URLS', '1');
    });
    afterAll(async () => {
      clearAdapters();
      vi.unstubAllEnvs();
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    it('keeps distinct fractional screenshots on disk', async () => {
      const out = join(dir, 'browser');
      await mkdir(out);
      const frames = await extractBrowserFrames(origin, out, {
        timestamps: [1.1, 1.2, 1.3],
        width: 320,
        height: 240,
      });
      const indices = await Promise.all(frames.map((frame) => frameIndex(frame.filePath)));
      expect(frames).toHaveLength(3);
      expect(new Set(frames.map((frame) => frame.filePath)).size).toBe(3);
      expect(indices).toEqual([11, 12, 13]);
      expect(frames.map((frame) => frame.timingOrigin)).toEqual(Array(3).fill('seek-target'));
      expect(frames.map((frame) => parseTimestamp(frame.time))).toEqual([1.1, 1.2, 1.3]);
    });
    it('preserves subsecond sampling through the get_frame_burst fallback', async () => {
      const adapter = new DirectAdapter();
      vi.spyOn(adapter, 'canHandle').mockReturnValue(true);
      vi.spyOn(adapter, 'downloadVideo').mockResolvedValue(null);
      registerAdapter(adapter);
      const result = await captureToolExecute(registerGetFrameBurst)(
        { url: `${origin}/`, from: '0:01.1', to: '0:01.3', count: 3 },
        noProgress,
      );
      const images = result.content.filter((c) => c.type === 'image');
      // Default viewport has pillarboxing: resize to source aspect before decoding.
      const indices = await Promise.all(
        images.map(async (c) =>
          frameIndex(
            await sharp(Buffer.from(c.data ?? '', 'base64'))
              .extract({ left: 160, top: 0, width: 960, height: 720 })
              .resize(320, 240)
              .toBuffer(),
          ),
        ),
      );
      expect(indices).toEqual([11, 12, 13]);
      expect(frameTimingsOf(result)).toEqual(
        [1, 2, 3].map((i) => ({
          time: `0:01.${i}`,
          timingOrigin: 'seek-target',
        })),
      );
    });
  },
);
