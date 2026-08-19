import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every call that puts a string in front of a user: a `warnings[]`-bound array
 * or an `onWarning` sink.
 *
 * The prefix wildcard matters. `src/cli.ts` collects into `copyWarnings` and a
 * local `errors`, both of which reach the public `warnings[]` through
 * `assembleResultDoc({ extraWarnings })`. An exact-name list walked straight
 * past them, so two absolute-path leaks sat outside the guard that exists to
 * stop exactly that (issue #46).
 */
const EMITTER = /\b\w*(?:[Ww]arnings|[Ee]rrors|reasons)\.push\s*\(|\bonWarning\??\.?\s*\(/g;

/** The translators that are allowed to produce a warning's reason. */
const TRANSLATORS = ['warningReason(', 'extractYtDlpError(', 'ffmpegCrashReason('];

/** Reading a caught error's text: the thing that must never reach a user raw. */
const RAW_ERROR = /\.message\b|String\(\s*(?:e|err|error)\s*\)/;

/**
 * The `${…}` expressions inside the emitter call that starts at `open`.
 *
 * Walks parentheses so a call spanning several lines (most of them do) is read
 * whole, and template nesting inside the argument does not end it early.
 */
function interpolationsIn(source: string, open: number): string[] {
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const argument = source.slice(open, end);
  const found: string[] = [];
  const expression = /\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(argument)) !== null) found.push(match[1]);
  // `warnings.push(warningReason(e))` — no template literal, still an argument
  // that has to be proven safe.
  if (found.length === 0) found.push(argument);
  return found;
}

/**
 * Reasons that a source file feeds a raw caught error into a user-visible
 * warning. Empty means the file is clean.
 *
 * Positive assertion, as issue #24 taught: an expression passes only when it
 * can be PROVEN not to carry a raw error — either it never reads one, or it
 * routes through a translator. "Cannot prove it" is a failure, not a pass.
 */
export function rawErrorInWarnings(source: string): string[] {
  const offenders: string[] = [];
  EMITTER.lastIndex = 0;
  let call: RegExpExecArray | null;
  while ((call = EMITTER.exec(source)) !== null) {
    const open = source.indexOf('(', call.index + call[0].length - 1);
    if (open === -1) continue;
    for (const expression of interpolationsIn(source, open)) {
      if (!RAW_ERROR.test(expression)) continue;
      if (TRANSLATORS.some((t) => expression.includes(t))) continue;
      offenders.push(expression.replace(/\s+/g, ' ').trim().slice(0, 120));
    }
  }
  return offenders;
}

function tsSources(dir: string): [name: string, source: string][] {
  const out: [string, string][] = [];
  // `withFileTypes` answers "directory?" from the same syscall that listed the
  // entry. A separate statSync would be a check the later read cannot rely on
  // (CodeQL js/file-system-race), and one syscall per entry more.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsSources(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
      out.push([full.slice(SRC_DIR.length + 1), readFileSync(full, 'utf-8')]);
  }
  return out;
}

/**
 * Guards the CLASS of bug behind issue #46, not the one instance.
 *
 * `warnings[]` is public output — returned to the MCP client, read into the
 * agent's context, and written to disk beside the user's video under
 * `MCP_WRITE_SIDECARS=1`. A spawned binary's `e.message` is `Command failed:`
 * plus the entire argv and stderr, so one `${e.message}` puts hundreds of lines
 * of local filesystem paths there. It happened three times in this repo
 * (yt-dlp, frames, audio) and each fix stayed local to its own file.
 *
 * Scanning the source catches the next one at authoring time; a behavioural
 * test only ever covers the call sites that already exist.
 */
describe('warning emitters across src/', () => {
  const sources = tsSources(SRC_DIR);
  const emitters = sources.filter(([, source]) => {
    EMITTER.lastIndex = 0;
    return EMITTER.test(source);
  });

  it('finds warning emitters to check', () => {
    // Without this the suite goes green by scanning nothing — the "test that
    // cannot fail" shape that let #46 ship in the first place.
    expect(emitters.length).toBeGreaterThan(5);
  });

  it.each(emitters.map(([name]) => name))('%s translates every error it reports', (name) => {
    const source = emitters.find(([f]) => f === name)?.[1] ?? '';

    expect(
      rawErrorInWarnings(source),
      `${name}: a warning is built from a raw caught error. Wrap it in ` +
        `warningReason() from utils/warnings.js — warnings[] reaches the MCP ` +
        `client, the agent's context and the sidecar on disk, and a spawned ` +
        `binary's message is the full argv plus stderr (issue #46).`,
    ).toEqual([]);
  });
});

/**
 * The detector's own regression suite. A guard that passes against the real
 * pre-fix code while claiming to catch it is worse than no guard, so the
 * historical lines are pinned here verbatim, pulled from `git show`.
 */
describe('rawErrorInWarnings', () => {
  it.each([
    [
      'issue #46, analyze-core.ts@0413f71 (whisper, the one that leaked)',
      'warnings.push(`Whisper fallback failed: ${e instanceof Error ? e.message : String(e)}`);',
    ],
    [
      'issue #46, get-frames.ts@0413f71 (browser, the sibling left behind)',
      'warnings.push(`Browser extraction failed: ${e instanceof Error ? e.message : String(e)}`);',
    ],
    [
      'issue #46, audio-transcriber.ts@0413f71 (whisper CLI, a spawned process)',
      'onWarning?.(`Whisper CLI failed: ${e instanceof Error ? e.message : String(e)}`);',
    ],
    [
      'the pre-fix src/cli.ts frame-copy error, which the old exact-name EMITTER missed',
      'errors.push(`Frame copy to ${dest} failed: ${err instanceof Error ? err.message : String(err)}`);',
    ],
    [
      'the pre-fix src/cli.ts copy-failure warning, collected as copyWarnings',
      [
        'copyWarnings.push(',
        '  `Frame images could not be copied to the output dir: ${err instanceof Error ? err.message : String(err)}`,',
        ');',
      ].join('\n'),
    ],
    [
      'a raw error passed with no template at all',
      'warnings.push(e instanceof Error ? e.message : String(e));',
    ],
    [
      'a multi-line call, which is how most of them are formatted',
      [
        'warnings.push(',
        '  `OCR failed: ${e instanceof Error ? e.message : String(e)}`,',
        ');',
      ].join('\n'),
    ],
  ])('catches %s', (_label, snippet) => {
    expect(rawErrorInWarnings(snippet)).not.toEqual([]);
  });

  it.each([
    ['a translated reason', 'warnings.push(`OCR failed: ${warningReason(e)}`);'],
    ['the yt-dlp translator', 'onWarning?.(`Video download failed: ${extractYtDlpError(err)}`);'],
    [
      'an error name, which carries no path',
      "warnings.push(`Failed: ${e instanceof Error ? e.name : 'error'}`);",
    ],
    ['a fixed sentence', "warnings.push('This video has no audio track.');"],
    ['a count', 'warnings.push(`Removed ${before - frames.length} duplicate frames`);'],
    ['an HTTP status', 'reasons.push(`Loom CDN returned HTTP ${response.status}`);'],
  ])('passes %s', (_label, snippet) => {
    expect(rawErrorInWarnings(snippet)).toEqual([]);
  });
});
