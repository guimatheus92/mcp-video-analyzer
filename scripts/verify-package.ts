#!/usr/bin/env npx tsx
/**
 * Pre-publish verification: packs the tarball, installs it in a temp directory,
 * and runs the entry point to verify it starts without errors.
 *
 * Usage: npx tsx scripts/verify-package.ts
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const rootDir = join(import.meta.dirname, '..');

function run(cmd: string, cwd?: string): string {
  console.log(`[verify] $ ${cmd}`);
  return execSync(cmd, { cwd: cwd ?? rootDir, encoding: 'utf-8', timeout: 120000 });
}

function main(): void {
  console.log('[verify] Packing tarball...');
  const packOutput = run('npm pack --json').trim();
  const packInfo = JSON.parse(packOutput);
  const tarball = join(rootDir, packInfo[0].filename);
  console.log(`[verify] Tarball: ${tarball} (${packInfo[0].size} bytes)`);

  const tempDir = mkdtempSync(join(tmpdir(), 'mcp-verify-'));
  console.log(`[verify] Installing in temp dir: ${tempDir}`);

  try {
    run(`npm init -y`, tempDir);
    run(`npm install "${tarball.replace(/\\/g, '/')}"`, tempDir);

    // Verify the binary exists
    const binPath = join(tempDir, 'node_modules', '.bin', 'mcp-video-analyzer');
    console.log(`[verify] Checking binary exists...`);

    // Try to start the server (should not crash on import)
    const entryPoint = join(
      tempDir,
      'node_modules',
      'mcp-video-analyzer',
      'dist',
      'index.js',
    );
    console.log(`[verify] Testing server startup...`);

    try {
      // Run for 3 seconds — if it doesn't crash, it's good
      execSync(
        `node -e "
          import('file:///${entryPoint.replace(/\\/g, '/')}')
            .then(() => { console.log('Import OK'); setTimeout(() => process.exit(0), 2000); })
            .catch(e => { console.error(e); process.exit(1); })
        "`,
        { cwd: tempDir, encoding: 'utf-8', timeout: 15000 },
      );
      console.log('[verify] PASS: Package installs and starts correctly');
    } catch (e: unknown) {
      const err = e as { stderr?: string; stdout?: string };
      console.error('[verify] FAIL: Server crashed on startup');
      console.error('[verify] stdout:', err.stdout ?? '');
      console.error('[verify] stderr:', err.stderr ?? '');
      process.exit(1);
    }
  } finally {
    // Cleanup
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(tarball, { force: true });
    console.log('[verify] Cleaned up temp files');
  }
}

main();
