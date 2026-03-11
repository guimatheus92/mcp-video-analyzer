import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const TIMEOUT_MS = 15000;
const testDir = fileURLToPath(new URL('.', import.meta.url));
const entryPoint = join(testDir, '..', '..', 'dist', 'index.js');

describe('MCP server smoke test', () => {
  let proc: ChildProcess | null = null;

  afterEach(() => {
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM');
    }
    proc = null;
  });

  it(
    'starts and responds to MCP initialize request',
    async () => {
      proc = spawn('node', [entryPoint], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      });

      let stdout = '';
      let stderr = '';

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      proc.stdout!.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      proc.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // Wait for server to start
      await new Promise((r) => setTimeout(r, 2000));

      // Check it didn't crash
      expect(proc.exitCode, `Server crashed on startup. stderr: ${stderr}`).toBeNull();

      // Send MCP initialize request
      const initRequest = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smoke-test', version: '1.0.0' },
        },
      });

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      proc.stdin!.write(initRequest + '\n');

      // Wait for response
      const response = await Promise.race([
        new Promise<string>((resolve) => {
          const check = (): void => {
            if (stdout.includes('"result"')) {
              resolve(stdout);
            } else {
              setTimeout(check, 200);
            }
          };
          check();
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout waiting for MCP response')), TIMEOUT_MS),
        ),
      ]);

      // Parse and validate response
      const jsonMatch = response.match(/\{[^]*"result"[^]*\}/);
      expect(jsonMatch, 'No JSON-RPC result found in output').not.toBeNull();

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const parsed = JSON.parse(jsonMatch![0]);
      expect(parsed.result?.serverInfo?.name).toBe('mcp-video-analyzer');
      expect(parsed.result?.capabilities).toBeDefined();
    },
    TIMEOUT_MS + 5000,
  );
});
