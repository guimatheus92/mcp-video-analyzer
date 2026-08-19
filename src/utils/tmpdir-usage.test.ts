import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../test/helpers/index.js';

/**
 * Enforces the repo-wide rule the CodeQL `js/insecure-temporary-file` fix
 * introduced: no persistent on-disk location may use a FIXED name under
 * `os.tmpdir()`. Per-call scratch space is fine — `mkdtemp` randomizes it and
 * creates it 0700 — but `join(tmpdir(), 'some-name')` is pre-creatable by any
 * other local user, who then reads whatever we write there.
 *
 * A scan, not a behavioural test, for the same reason the `-o %(ext)s` and raw
 * `${e.message}` guards are scans: it catches the NEXT instance at authoring
 * time, which is the only feedback a security invariant gets before a CodeQL
 * run on some later PR.
 */

/** Every `tmpdir()` use that is not immediately wrapped by `mkdtemp*(join(...))`. */
export function fixedNameTmpdirUses(source: string): string[] {
  const offenders: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.includes('tmpdir()')) continue;
    if (line.includes('ALLOW_FIXED_TMPDIR')) continue; // opt-out, must be justified in place
    // A comment-only line never executes — including the ones in this repo
    // that quote the forbidden shape on purpose to explain it. Code with a
    // TRAILING comment is still scanned.
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    // `mkdtemp(join(tmpdir(), 'prefix'))` / `mkdtempSync(...)` — randomized, safe.
    if (/mkdtemp(Sync)?\s*\(\s*join\s*\(\s*tmpdir\(\)/.test(line)) continue;
    // A bare `tmpdir()` reference (a comparison, or the uid-keyed fallback) is
    // only an offender when a fixed segment is joined onto it.
    if (/join\s*\(\s*tmpdir\(\)\s*,/.test(line)) offenders.push(line.trim());
  }
  return offenders;
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.cache') continue;
    // This file is the detector: it holds the pre-fix offenders verbatim as
    // pinned fixtures, so scanning itself would always fail.
    if (entry.name === 'tmpdir-usage.test.ts') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('fixedNameTmpdirUses (the detector itself)', () => {
  it('flags the real pre-fix line from test/helpers/golden-clips.ts', () => {
    // Pinned verbatim from git history — the line CodeQL actually followed into
    // the sidecar writes. Proving the detector against the real thing, not a
    // hand-written approximation.
    expect(
      fixedNameTmpdirUses(
        "const GOLDEN_DIR = join(tmpdir(), 'mcp-video-analyzer', 'test-golden');",
      ),
    ).toHaveLength(1);
  });

  it('flags the real pre-fix line from src/utils/temp-files.ts', () => {
    expect(
      fixedNameTmpdirUses("  return join(tmpdir(), 'mcp-video-analyzer', ...segments);"),
    ).toHaveLength(1);
  });

  it('ignores comment lines but not code with a trailing comment', () => {
    expect(fixedNameTmpdirUses("    // join(tmpdir(), 'app') is what we must not do")).toEqual([]);
    expect(
      fixedNameTmpdirUses("const d = join(tmpdir(), 'app'); // still an offender"),
    ).toHaveLength(1);
  });

  it('allows mkdtemp, which randomizes the name and creates it 0700', () => {
    expect(fixedNameTmpdirUses("const dir = await mkdtemp(join(tmpdir(), 'mcp-video-'));")).toEqual(
      [],
    );
    expect(fixedNameTmpdirUses("tmp = mkdtempSync(join(tmpdir(), 'local-adapter-'));")).toEqual([]);
  });
});

describe('no fixed-name os.tmpdir() paths in src/ or test/', () => {
  const files = [...tsFiles(join(REPO_ROOT, 'src')), ...tsFiles(join(REPO_ROOT, 'test'))];

  it('scanned a meaningful number of files', () => {
    // A scan that matches nothing must not pass silently (repo testing rule).
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.includes('temp-files.ts'))).toBe(true);
    expect(files.some((f) => f.includes('golden-clips.ts'))).toBe(true);
  });

  it('finds no offenders', () => {
    const offenders = files.flatMap((f) =>
      fixedNameTmpdirUses(readFileSync(f, 'utf-8')).map(
        (line) => `${f.slice(REPO_ROOT.length + 1)}: ${line}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
