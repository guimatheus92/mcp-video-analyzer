import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import type { FastMCP } from 'fastmcp';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const ffmpegPath = require('ffmpeg-static') as string;

interface ToolContent {
  type: string;
  text?: string;
  /** base64 payload of an `image` part. */
  data?: string;
}
interface ToolResult {
  content: ToolContent[];
}
type ToolExecute = (
  args: Record<string, unknown>,
  ctx: { reportProgress: (progress: unknown) => Promise<void> },
) => Promise<ToolResult>;

// Shared parsers for the frame-tool JSON text block — CLAUDE.md: don't redefine
// helpers in each test file.
function parseDoc(result: ToolResult): { frameCount?: number; warnings?: string[] } {
  const text = result.content.find((c) => c.type === 'text')?.text ?? '{}';
  return JSON.parse(text);
}
/** `frameCount` from a tool's JSON text block. */
export function frameCountOf(result: ToolResult): number {
  return parseDoc(result).frameCount ?? 0;
}
/** `warnings` from a tool's JSON text block. */
export function warningsOf(result: ToolResult): string[] {
  return parseDoc(result).warnings ?? [];
}
/** Number of image content parts in a tool result. */
export function imageCount(result: ToolResult): number {
  return result.content.filter((c) => c.type === 'image').length;
}

/**
 * Decoded pixel widths of the image parts in a tool result.
 *
 * The only way to prove a per-call `maxWidth` reached the emitted frame: each
 * tool wires it from a different argument shape (`options?.maxWidth`,
 * `args.maxWidth`, `params.maxWidth`), and a dropped option silently falls back
 * to the 800 px default instead of erroring — so it compiles and the rest of
 * the suite stays green.
 */
export async function imageWidths(result: ToolResult): Promise<number[]> {
  const widths: number[] = [];
  for (const part of result.content) {
    if (part.type !== 'image' || part.data === undefined) continue;
    const meta = await sharp(Buffer.from(part.data, 'base64')).metadata();
    widths.push(meta.width ?? 0);
  }
  return widths;
}

/**
 * Capture a tool's `execute` by stubbing `server.addTool` — lets a unit test
 * drive the handler directly, with no MCP transport. The frame-tool tests had
 * no way to exercise `execute` before this, which is why the zero-frame throws
 * (issue #26) went untested.
 */
export function captureToolExecute(register: (server: FastMCP) => void): ToolExecute {
  let execute: ToolExecute | undefined;
  register({
    addTool: (cfg: { execute: ToolExecute }) => {
      execute = cfg.execute;
    },
  } as unknown as FastMCP);
  if (!execute) throw new Error('register() did not call addTool');
  return execute;
}

/** Stub execution context — the frame tools only touch `reportProgress`. */
export const noProgress = {
  reportProgress: async (): Promise<void> => {
    // no-op: tests don't assert progress
  },
};

/**
 * A solid `testsrc` clip (moving pattern, NOT black) that survives black-frame
 * filtering — the "real content still works" control. `tiny.mp4` can't serve
 * this: it's a pure-black clip whose frames are all filtered out.
 *
 * `size` matters for width assertions: pick something wider than the 800 px
 * default cap so "capped at the default" and "source resolution" are
 * distinguishable outcomes.
 */
export function generateTestClip(path: string, seconds = 3, size = '320x240'): Promise<void> {
  return runFfmpeg([
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=${size}:rate=10:duration=${seconds}`,
    '-pix_fmt',
    'yuv420p',
    path,
  ]);
}

/**
 * Run ffmpeg (the bundled binary unless `bin` overrides it), failing LOUD
 * with the stderr tail. Golden-clip generation depends on drawtext/freetype
 * being compiled in — if it isn't, the test must fail with ffmpeg's own
 * error ("No such filter: 'drawtext'"), never silently skip.
 */
export function runFfmpeg(args: string[], bin: string = ffmpegPath): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`)),
    );
  });
}
