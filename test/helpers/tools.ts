import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import type { FastMCP } from 'fastmcp';

const require = createRequire(import.meta.url);
const ffmpegPath = require('ffmpeg-static') as string;

interface ToolContent {
  type: string;
  text?: string;
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
 */
export function generateTestClip(path: string, seconds = 3): Promise<void> {
  return runFfmpeg([
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=320x240:rate=10:duration=${seconds}`,
    '-pix_fmt',
    'yuv420p',
    path,
  ]);
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: 'ignore' });
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)),
    );
  });
}
