#!/usr/bin/env npx tsx
/**
 * Smoke test: spawns the built MCP server and verifies it responds to an MCP initialize request.
 * Run after `npm run build` to ensure the package starts correctly.
 *
 * Usage: npx tsx scripts/smoke-test.ts
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

const TIMEOUT_MS = 15000;
const entryPoint = join(import.meta.dirname, '..', 'dist', 'index.js');

async function main(): Promise<void> {
  console.log(`[smoke] Starting server: node ${entryPoint}`);

  const proc = spawn('node', [entryPoint], {
    stdio: ['pipe', 'pipe', 'pipe'],
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

  // Wait briefly for the server to start
  await new Promise((r) => setTimeout(r, 2000));

  // Check if it crashed
  if (proc.exitCode !== null) {
    console.error(`[smoke] FAIL: Server exited with code ${proc.exitCode}`);
    console.error(`[smoke] stderr: ${stderr}`);
    process.exit(1);
  }

  // Send an MCP initialize request via JSON-RPC over stdio
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

  proc.stdin.write(initRequest + '\n');

  // Wait for a response
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

  // Kill the server
  proc.kill('SIGTERM');

  // Validate response
  try {
    // Find the JSON-RPC response in stdout
    const jsonMatch = response.match(/\{[^]*"result"[^]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON-RPC result found in output');
    }
    const parsed = JSON.parse(jsonMatch[0]);

    if (parsed.result?.serverInfo?.name !== 'mcp-video-analyzer') {
      throw new Error(
        `Unexpected server name: ${parsed.result?.serverInfo?.name ?? 'undefined'}`,
      );
    }

    console.log(`[smoke] PASS: Server responded correctly`);
    console.log(
      `[smoke] Server: ${parsed.result.serverInfo.name} v${parsed.result.serverInfo.version}`,
    );
    console.log(
      `[smoke] Capabilities: ${Object.keys(parsed.result.capabilities ?? {}).join(', ')}`,
    );
  } catch (e) {
    console.error(`[smoke] FAIL: Invalid response`);
    console.error(`[smoke] stdout: ${stdout}`);
    console.error(`[smoke] stderr: ${stderr}`);
    console.error(`[smoke] error: ${e}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`[smoke] FAIL: ${e}`);
  process.exit(1);
});
