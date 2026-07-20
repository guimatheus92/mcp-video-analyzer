import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** `-o` / `--output` in any quoting style. */
const OUTPUT_FLAG = /['"`]--?(?:o|output)['"`]\s*,\s*/g;

/**
 * Extracts each yt-dlp output-template argument in a source file.
 *
 * Reads to the end of the argument rather than to the next comma, so a nested
 * call like `join(destDir, 'video.%(ext)s')` survives intact. Exported as a
 * plain function so the detector itself can be tested — a guard nobody
 * verifies is how issue #24 shipped in the first place.
 */
export function outputTemplateArgs(source: string): string[] {
  const args: string[] = [];

  for (const match of source.matchAll(OUTPUT_FLAG)) {
    const start = match.index + match[0].length;
    let depth = 0;
    let end = start;

    for (; end < source.length; end++) {
      const c = source[end];
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) {
        if (depth === 0) break;
        depth--;
      } else if ((c === ',' || c === '\n') && depth === 0) break;
    }

    args.push(source.slice(start, end).trim());
  }

  return args;
}

/**
 * True when we can PROVE the template is container-agnostic.
 *
 * Deliberately a positive assertion. The first version of this guard
 * blacklisted literal extensions in a fixed window after `-o`, which the real
 * issue #24 code slipped straight past — it wrote
 * `const outputPath = join(destDir, `${videoId}.mp4`)` and then passed
 * `outputPath`, so no extension appeared near the flag at all. "Can't prove
 * it" must read as a failure, never as a pass.
 */
export function isExtensionAgnostic(arg: string, source: string): boolean {
  let expression = arg;

  // One hop of indirection: `-o` was handed a local binding — the exact shape
  // the real #24 code used. Resolve it, and fail if we can't.
  const identifier = /^[A-Za-z_$][\w$]*$/.exec(arg)?.[0];
  if (identifier) {
    const declaration = new RegExp(
      `(?:const|let|var)\\s+${identifier}\\s*(?::[^=]+)?=\\s*([^;]+);`,
    ).exec(source);
    if (!declaration) return false;
    expression = declaration[1];
  }

  if (expression.includes('%(ext)s')) return true;
  // A stem with no extension at all is fine too — yt-dlp appends the real one
  // and the call site globs for it (e.g. the subtitle path's `subs` → `.vtt`).
  return !/\.(mp4|webm|mkv|mov|avi|flv|m4a|mp3|opus|wav)['"`]/.test(expression);
}

function tsSources(dir: string): [name: string, source: string][] {
  const out: [string, string][] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsSources(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push([full.slice(SRC_DIR.length + 1), readFileSync(full, 'utf-8')]);
    }
  }
  return out;
}

/**
 * Guards the CLASS of bug behind issue #24, not just the one instance.
 *
 * yt-dlp appends the REAL container to whatever `-o` template it is given, so
 * `-o x.mp4` writes `x.mp4.webm` when it merges DASH streams and every
 * `existsSync('x.mp4')` after it throws away a download that worked. Scanning
 * the source catches that at authoring time; a behavioural test only covers
 * the call sites that already exist.
 *
 * Scans all of `src/` — CLAUDE.md states the invariant repo-wide, and a future
 * yt-dlp spawn is at least as likely to land in `utils/` as in an adapter.
 */
describe('yt-dlp -o templates across src/', () => {
  const sources = tsSources(SRC_DIR);
  const withOutputArg = sources.filter(([, source]) => outputTemplateArgs(source).length > 0);

  it('finds at least one yt-dlp output template to check', () => {
    // Without this the suite goes green by scanning nothing — the "test that
    // can never fail" shape that let #24 through.
    expect(withOutputArg.length).toBeGreaterThan(0);
  });

  it.each(withOutputArg.map(([name]) => name))('%s keeps -o container-agnostic', (name) => {
    const source = withOutputArg.find(([f]) => f === name)?.[1] ?? '';

    for (const arg of outputTemplateArgs(source)) {
      expect(
        isExtensionAgnostic(arg, source),
        `${name}: cannot prove the -o template "${arg}" is container-agnostic. Use ` +
          `'%(ext)s' and glob the result — yt-dlp appends the real container when it ` +
          `merges streams (issue #24).`,
      ).toBe(true);
    }
  });
});

/**
 * The detector's own regression suite. The previous guard passed against the
 * real pre-fix code while claiming to catch it, so the historical snippet is
 * pinned here verbatim as the primary case.
 */
describe('isExtensionAgnostic', () => {
  const issue24 = [
    "const outputPath = join(destDir, `${videoId ?? 'loom_video'}.mp4`);",
    "await runYtDlp(ytDlp, ['-o', outputPath, '--no-warnings', '-q', url], { timeout: 120000 });",
  ].join('\n');

  it('rejects the actual issue #24 code (extension held in a variable)', () => {
    const [arg] = outputTemplateArgs(issue24);
    expect(arg).toBe('outputPath');
    expect(isExtensionAgnostic(arg, issue24)).toBe(false);
  });

  it('rejects an inline literal extension', () => {
    const source = "runYtDlp(bin, ['-o', join(destDir, 'video.mp4'), url]);";
    expect(isExtensionAgnostic(outputTemplateArgs(source)[0], source)).toBe(false);
  });

  it('accepts an inline %(ext)s template', () => {
    const source = "runYtDlp(bin, ['-o', join(destDir, 'video.%(ext)s'), url]);";
    expect(isExtensionAgnostic(outputTemplateArgs(source)[0], source)).toBe(true);
  });

  it('accepts %(ext)s reached through one binding', () => {
    const source = [
      "const out = join(destDir, 'video.%(ext)s');",
      "runYtDlp(bin, ['-o', out, url]);",
    ].join('\n');
    expect(isExtensionAgnostic(outputTemplateArgs(source)[0], source)).toBe(true);
  });

  it.each(['"-o", join(d, \'v.mp4\')', "'--output', join(d, 'v.mp4')", "`-o`, join(d, 'v.mp4')"])(
    'finds the output argument written as %s',
    (spelling) => {
      expect(outputTemplateArgs(`runYtDlp(bin, [${spelling}, url]);`)).toHaveLength(1);
    },
  );
});
