import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ADAPTERS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Any container extension yt-dlp might pick. A literal one of these in an `-o`
 * template is the bug: on a DASH merge yt-dlp appends the REAL container to
 * whatever you gave it, so `-o x.mp4` produces `x.mp4.webm` and every
 * `existsSync('x.mp4')` after it silently fails.
 */
const LITERAL_EXTENSION = /\.(mp4|webm|mkv|mov|avi|flv|m4a|mp3|opus|wav)['"`]/;

/** How much of the expression after `'-o',` to inspect. */
const ARG_WINDOW = 160;

/** Comments discuss the bug by name (`-o x.mp4`) — scan code only. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Guards the CLASS of bug behind issue #24, not just the one instance.
 *
 * A new adapter reintroducing `-o <name>.mp4` would download fine and then
 * throw the file away — silently, since the pipeline reads a missing file as
 * "no video". Scanning the source is what catches that at authoring time; a
 * behavioural test only covers adapters that already exist.
 */
describe('yt-dlp -o templates across adapters', () => {
  const sources = readdirSync(ADAPTERS_DIR)
    .filter((f) => f.endsWith('.adapter.ts'))
    .map((f) => [f, stripComments(readFileSync(join(ADAPTERS_DIR, f), 'utf-8'))] as const);

  it('finds adapter sources to scan', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it.each(sources.map(([name]) => name))('%s uses no literal extension in -o', (name) => {
    const source = sources.find(([f]) => f === name)?.[1] ?? '';

    for (let i = source.indexOf("'-o'"); i !== -1; i = source.indexOf("'-o'", i + 1)) {
      const target = source.slice(i, i + ARG_WINDOW);
      expect(
        LITERAL_EXTENSION.test(target),
        `${name}: -o template hardcodes a container extension. Use '%(ext)s' and glob the ` +
          `result — yt-dlp appends the real container when it merges streams (issue #24).\n` +
          `  near: ${target.split('\n').slice(0, 3).join(' ').trim()}`,
      ).toBe(false);
    }
  });
});
