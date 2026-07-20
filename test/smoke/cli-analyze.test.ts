import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateTestClip } from '../helpers/index.js';

const testDir = fileURLToPath(new URL('.', import.meta.url));
const entryPoint = join(testDir, '..', '..', 'dist', 'index.js');
const tinyMp4 = join(testDir, '..', 'fixtures', 'tiny.mp4');

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [entryPoint, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('CLI smoke test', () => {
  let scratch: string;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'cli-smoke-'));
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it('analyze <local file> --detail brief prints a single JSON document on stdout', async () => {
    const { code, stdout, stderr } = await run(['analyze', tinyMp4, '--detail', 'brief']);

    expect(code, `stderr: ${stderr}`).toBe(0);
    // stdout must be nothing but the JSON document (the skill contract).
    const doc = JSON.parse(stdout);
    expect(doc.metadata?.title).toBe('tiny.mp4');
    expect(Array.isArray(doc.warnings)).toBe(true);
    expect(typeof doc.frameCount).toBe('number');
  });

  it('resolves a relative path against the shell cwd', async () => {
    const { code, stdout, stderr } = await run(
      ['analyze', 'tiny.mp4', '--detail', 'brief'],
      dirname(tinyMp4),
    );

    expect(code, `stderr: ${stderr}`).toBe(0);
    expect(JSON.parse(stdout).metadata?.title).toBe('tiny.mp4');
  });

  it('--fields metadata,transcript omits frames, keeps frameCount, creates no out dir', async () => {
    const outDir = join(scratch, 'never-created');
    const { code, stdout } = await run([
      'analyze',
      tinyMp4,
      '--fields',
      'metadata,transcript',
      '--out',
      outDir,
    ]);

    expect(code).toBe(0);
    const doc = JSON.parse(stdout);
    expect(doc.frames).toBeUndefined();
    expect(typeof doc.frameCount).toBe('number');
    expect(Array.isArray(doc.transcript)).toBe(true);
    expect(existsSync(outDir)).toBe(false);
  });

  it('copies frame files that survive process exit (copy-before-cleanup invariant)', async () => {
    // tiny.mp4 is a black clip whose frames are filtered out, so generate a
    // clip with real content for the frames path (shared helper — one source).
    const clip = join(scratch, 'testsrc.mp4');
    await generateTestClip(clip, 6);

    const outDir = join(scratch, 'frames-out');
    const { code, stdout, stderr } = await run([
      'analyze',
      clip,
      '--max-frames',
      '3',
      '--out',
      outDir,
    ]);

    expect(code, `stderr: ${stderr}`).toBe(0);
    const doc = JSON.parse(stdout);
    expect(doc.frameCount).toBeGreaterThanOrEqual(1);
    expect(doc.frames.length).toBeGreaterThanOrEqual(1);
    for (const frame of doc.frames) {
      expect(frame.filePath.startsWith(outDir)).toBe(true);
      // The whole point of the CLI: paths must still exist after the
      // subprocess (and its temp-dir cleanup) has fully exited.
      expect(existsSync(frame.filePath)).toBe(true);
    }
  }, 120_000);

  it('analyze --help exits 0 with usage on stdout', async () => {
    const { code, stdout } = await run(['analyze', '--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Usage: mcp-video-analyzer analyze');
  });

  it('analyze with an unsupported source exits 1 with stderr only', async () => {
    const { code, stdout, stderr } = await run(['analyze', 'not-a-video']);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('supported video URL');
  });

  it('analyze with an invalid option value exits 1 with the formatted zod error', async () => {
    const { code, stdout, stderr } = await run(['analyze', tinyMp4, '--detail', 'wrong']);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Invalid option "detail"');
  });

  it('an unknown top-level command exits 1 with stderr only', async () => {
    const { code, stdout, stderr } = await run(['bogus']);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Unknown command "bogus"');
  });

  it('top-level --help exits 0 with usage on stdout', async () => {
    const { code, stdout } = await run(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Start the MCP server');
  });

  it('--version prints the version', async () => {
    const { code, stdout } = await run(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
