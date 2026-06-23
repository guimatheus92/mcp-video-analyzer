import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { ITranscriptEntry } from '../types.js';
import { parseVtt } from './vtt-parser.js';

/**
 * Look for a transcript/caption file next to `videoPath`.
 *
 * Tries (in priority order):
 *   1. <stem>.vtt
 *   2. <stem>.srt
 *   3. <stem>.<anything>.vtt — e.g. clip.en.vtt, clip.en-US.vtt
 *   4. <stem>.<anything>.srt
 *
 * SRT files are converted to VTT in-memory before parsing.
 *
 * Returns [] when nothing is found. Read errors and parse errors are
 * non-fatal — they degrade to "no sidecar".
 */
export async function findSidecarTranscript(videoPath: string): Promise<ITranscriptEntry[]> {
  const dir = dirname(videoPath);
  const stem = basename(videoPath, extname(videoPath));

  const sidecar = pickSidecar(dir, stem);
  if (!sidecar) return [];

  try {
    const raw = await readFile(sidecar.path, 'utf8');
    const vtt = sidecar.format === 'srt' ? srtToVtt(raw) : raw;
    return parseVtt(vtt);
  } catch {
    return [];
  }
}

interface SidecarMatch {
  path: string;
  format: 'vtt' | 'srt';
}

function pickSidecar(dir: string, stem: string): SidecarMatch | null {
  const direct: SidecarMatch[] = [
    { path: join(dir, `${stem}.vtt`), format: 'vtt' },
    { path: join(dir, `${stem}.srt`), format: 'srt' },
  ];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const entrySet = new Set(entries);

  for (const candidate of direct) {
    if (entrySet.has(basename(candidate.path))) return candidate;
  }

  // Language/qualifier variants: <stem>.<anything>.vtt|srt — sorted for
  // deterministic pick.
  const prefix = `${stem}.`;
  const variants: SidecarMatch[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const rest = entry.slice(prefix.length);
    if (!rest.includes('.')) continue;
    if (rest.endsWith('.vtt')) variants.push({ path: join(dir, entry), format: 'vtt' });
    else if (rest.endsWith('.srt')) variants.push({ path: join(dir, entry), format: 'srt' });
  }
  variants.sort((a, b) => {
    if (a.format !== b.format) return a.format === 'vtt' ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return variants[0] ?? null;
}

/**
 * Convert SRT to VTT in-memory. SRT differs from VTT only in:
 *   - no `WEBVTT` header
 *   - timestamps use `,` instead of `.` for milliseconds
 *
 * Anything more exotic (cue settings, styling) is handled by parseVtt's
 * existing tag-stripping behavior.
 */
export function srtToVtt(srt: string): string {
  const normalized = srt.replace(
    /(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}),(\d{3})/g,
    '$1.$2 --> $3.$4',
  );
  return `WEBVTT\n\n${normalized}`;
}
