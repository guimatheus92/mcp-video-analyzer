import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = fileURLToPath(new URL('.', import.meta.url));
const entryPoint = join(testDir, '..', '..', 'dist', 'index.js');
const tinyMp4 = join(testDir, '..', 'fixtures', 'tiny.mp4');

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [entryPoint, ...args], {
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
  it('analyze <local file> --detail brief prints a single JSON document on stdout', async () => {
    const { code, stdout, stderr } = await run(['analyze', tinyMp4, '--detail', 'brief']);

    expect(code, `stderr: ${stderr}`).toBe(0);
    // stdout must be nothing but the JSON document (the skill contract).
    const doc = JSON.parse(stdout);
    expect(doc.metadata?.title).toBe('tiny.mp4');
    expect(Array.isArray(doc.warnings)).toBe(true);
    expect(typeof doc.frameCount).toBe('number');
  });

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

  it('--version prints the version', async () => {
    const { code, stdout } = await run(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
