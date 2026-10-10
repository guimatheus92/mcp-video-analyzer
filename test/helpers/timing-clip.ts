import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { runFfmpeg } from './tools.js';

/** 10 fps; each frame encodes its index in a gray patch and a visible label. */
export async function timingClip(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  for (let index = 0; index < 30; index++) {
    const gray = 30 + index * 6;
    const label = Buffer.from(
      `<svg width="320" height="240"><text x="20" y="130" font-size="24" fill="white">Frame ${index} / ${(index / 10).toFixed(1)} s</text></svg>`,
    );
    await sharp({
      create: { width: 320, height: 240, channels: 3, background: { r: gray, g: gray, b: gray } },
    })
      .composite([{ input: label }])
      .png()
      .toFile(join(dir, `frame_${String(index).padStart(3, '0')}.png`));
  }
  const path = join(dir, 'timing.mp4');
  await runFfmpeg([
    '-y',
    '-framerate',
    '10',
    '-i',
    join(dir, 'frame_%03d.png'),
    '-c:v',
    'libx264',
    '-crf',
    '0',
    '-pix_fmt',
    'yuv420p',
    path,
  ]);
  return path;
}

/** Decode the source-frame identity from pixels, independently of reported time. */
export async function frameIndex(input: string | Buffer): Promise<number> {
  const { channels } = await sharp(input).extract({ left: 5, top: 5, width: 8, height: 8 }).stats();
  return Math.round((channels[0].mean - 30) / 6);
}
