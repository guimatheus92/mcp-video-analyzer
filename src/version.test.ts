import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { VERSION } from './version.js';

async function readJson(
  relative: string,
): Promise<{ version: string; engines?: { node?: string } }> {
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

/**
 * The Node floor is declared in six independent places (package.json engines,
 * both Dockerfile stages, README.md, AGENTS.md, skills/video/SKILL.md). v0.9.0
 * raised it to >=22.12 specifically to fix the unfixable `extract-zip`
 * advisory via puppeteer-core@25 — so an image that silently drifts back to an
 * older base tag would quietly undo a security fix while every test stayed
 * green. This guard is the only thing that notices.
 */
describe('Node floor', () => {
  it('has both Dockerfile stages on a base image that satisfies engines.node', async () => {
    const pkg = await readJson('../package.json');
    const declared = pkg.engines?.node;
    expect(declared, 'package.json engines.node').toBeTruthy();

    const floorMajor = Number(/(\d+)/.exec(declared ?? '')?.[1]);
    expect(Number.isInteger(floorMajor)).toBe(true);

    const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
    const tags = [...dockerfile.matchAll(/^FROM node:(\d+)[-\w.]*/gm)].map((m) => Number(m[1]));

    // Assert the scan found something: a regex that silently matches nothing
    // would make this guard pass on a Dockerfile that no longer uses Node.
    expect(tags.length, 'FROM node:<major> stages found in Dockerfile').toBeGreaterThanOrEqual(2);
    for (const tag of tags) {
      expect(
        tag,
        `Dockerfile base image node:${tag} vs engines.node ${declared}`,
      ).toBeGreaterThanOrEqual(floorMajor);
    }
  });

  it('states the same floor in every user-facing doc', async () => {
    const floor = (await readJson('../package.json')).engines?.node ?? '';
    // ">=22.12.0" -> "22.12", the form the prose uses.
    const [, major, minor] = /(\d+)\.(\d+)/.exec(floor) ?? [];
    expect(major, 'engines.node must carry a major.minor').toBeTruthy();
    const prose = `${major}.${minor}`;

    const docs = ['../README.md', '../AGENTS.md', '../skills/video/SKILL.md'];
    for (const doc of docs) {
      const text = await readFile(new URL(doc, import.meta.url), 'utf8');
      const mentions = [...text.matchAll(/Node(?:\.js)?\s+(\d+(?:\.\d+)?)\+/g)].map((m) => m[1]);
      // Same prove-it-scanned-something rule: a doc that stopped mentioning
      // Node at all must fail here, not pass by vacuous truth.
      expect(mentions.length, `Node version mentions in ${doc}`).toBeGreaterThan(0);
      for (const mention of mentions) {
        expect(mention, `${doc} states Node ${mention}+, expected ${prose}+`).toBe(prose);
      }
    }
  });
});
