import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { VERSION } from './version.js';

async function readJson(relative: string): Promise<{ version: string }> {
  return JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8'));
}

describe('VERSION', () => {
  it('matches package.json and .claude-plugin/plugin.json (release checklist)', async () => {
    const pkg = await readJson('../package.json');
    const plugin = await readJson('../.claude-plugin/plugin.json');
    expect(pkg.version).toBe(VERSION);
    expect(plugin.version).toBe(VERSION);
  });
});
