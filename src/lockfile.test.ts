import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../test/helpers/index.js';

/**
 * Every installed package in `package-lock.json` must keep its `resolved` URL
 * and `integrity` hash. Without the hash, `npm ci` installs the tarball without
 * checking it against a known digest — a supply-chain regression that no diff
 * reviewer sees, because lockfiles are excluded from automated review.
 *
 * PR #79 shipped exactly that: a lockfile regenerated from a `node_modules` that
 * lacked the metadata dropped both fields from 419 of 541 packages, inside a PR
 * whose purpose was a security fix. Regenerate from main's lockfile instead.
 */

interface LockEntry {
  resolved?: string;
  integrity?: string;
  link?: boolean;
  inBundle?: boolean;
}

/** Entries npm would install unverified. Workspace links and bundled deps legitimately have neither field. */
function unverifiable(lock: { packages?: Record<string, LockEntry> }): string[] {
  return Object.entries(lock.packages ?? {})
    .filter(([key, entry]) => key !== '' && !entry.link && !entry.inBundle)
    .filter(([, entry]) => !entry.resolved || !entry.integrity)
    .map(([key]) => key);
}

describe('package-lock.json integrity', () => {
  it('flags entries stripped the way PR #79 stripped them', () => {
    // Pinned verbatim: two entries from PR #79's lockfile (git show f3f2a6c:package-lock.json)
    // next to the same package as main records it.
    const pr79 = {
      packages: {
        '': { name: 'mcp-video-analyzer' },
        'node_modules/@apidevtools/swagger-methods': { version: '3.0.2', license: 'MIT' },
        'node_modules/@babel/code-frame/node_modules/js-tokens': {
          version: '4.0.0',
          dev: true,
          license: 'MIT',
        },
      },
    };
    const main = {
      packages: {
        'node_modules/@apidevtools/swagger-methods': {
          version: '3.0.2',
          resolved:
            'https://registry.npmjs.org/@apidevtools/swagger-methods/-/swagger-methods-3.0.2.tgz',
          integrity:
            'sha512-QAkD5kK2b1WfjDS/UQn/qQkbwF31uqRjPTrsCs5ZG9BQGAkjwvqGFjjPqAuzac/IYzpPtRzjCP1WrTuAIjMrXg==',
          license: 'MIT',
        },
      },
    };

    expect(unverifiable(pr79)).toEqual([
      'node_modules/@apidevtools/swagger-methods',
      'node_modules/@babel/code-frame/node_modules/js-tokens',
    ]);
    expect(unverifiable(main)).toEqual([]);
  });

  it('every installed package carries resolved + integrity', () => {
    const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, LockEntry>;
    };
    // A scan that matches nothing must not pass vacuously.
    expect(Object.keys(lock.packages ?? {}).length).toBeGreaterThan(100);
    expect(unverifiable(lock)).toEqual([]);
  });
});
