# Contributing to mcp-video-analyzer

Thanks for your interest in contributing! This guide will help you get started.

## Setup

Requires **Node.js 22.12+** (set by `puppeteer-core@25`; `sharp@0.35` needs
≥20.9 and `vite@8` needs ≥22.12 — see `package.json` `engines`).

```bash
git clone https://github.com/guimatheus92/mcp-video-analyzer.git
cd mcp-video-analyzer
npm install
```

### Optional dependencies

- **yt-dlp** — for primary frame extraction: `pip install yt-dlp`
- **Chrome/Chromium** — for browser-based frame extraction fallback (no install needed if already on your system)

## Development Workflow

```bash
# Run all checks (format, lint, typecheck, knip, tests) — do this before every commit
npm run check

# Run tests in watch mode during development
npm run test:watch

# Auto-fix formatting and lint issues
npm run format && npm run lint:fix

# Audit the dependencies the published package actually ships
npm run security

# Open the MCP Inspector for manual testing
npm run inspect
```

## Running Tests

```bash
npm run test              # Unit tests (fast, no network)
npm run test:coverage     # Unit tests with coverage report
npm run test:e2e          # E2E tests (requires network + yt-dlp/Chrome)
npm run test:formats      # Just the video-format matrix (~15s warm; one
                          # ~7MB tesseract traineddata fetch on a cold cache)
```

Tests live next to their source files: `foo.ts` → `foo.test.ts`.

Two e2e opt-ins/quirks:

- `WHISPER_E2E=1 npm run test:e2e` also runs the transcription outcome test (needs a whisper CLI — `pip install -U openai-whisper` or `pipx install whisper-ctranslate2` + `WHISPER_BIN=whisper-ctranslate2`). With the flag set and no whisper installed the test **fails** by design; CI always runs it.
- `BROWSER_E2E=1 npm run test:e2e` also runs the browser frame-extraction outcome test (needs Google Chrome installed — puppeteer-core resolves `channel: 'chrome'`). Same contract as `WHISPER_E2E`: flag set with no Chrome **fails**, it never skips. Without it the browser fallback ships unverified, because every failure inside `extractBrowserFrames` degrades to an empty array — a regression and "no frames" look identical.
- On Linux, golden text clips need a drawtext-capable ffmpeg: `GOLDEN_FFMPEG=ffmpeg npm run test:e2e` (distro ffmpeg; the bundled `ffmpeg-static` Linux build lacks drawtext). Windows/macOS need nothing.

## Security checks

```bash
npm run security      # shipped deps only (--omit=dev), fails at moderate+
npm run security:all  # whole tree including devDependencies, fails at high+
```

Both run as blocking CI jobs on every PR, on every push to `main`, **and on a
weekly cron**. The cron matters: `npm audit` reads a *live* advisory database,
so a PR that was green yesterday can go red today with no code change. That is
working as intended, not a flake.

`npm run security` is deliberately **not** part of `npm run check`. `check` is
what `prepublishOnly` runs and has to stay offline and deterministic — wiring a
live network lookup into it means an advisory published overnight fails
`npm publish` for code that never changed.

Two thresholds, on purpose. Shipped dependencies (what reaches a user through
the npm tarball and the Docker runtime stage) get the stricter `moderate` bar.
The full tree is gated at `high`, so dev-tool moderate churn does not block an
unrelated bug fix — while still catching the next critical in a test runner
(**both** criticals fixed in v0.9.0 were dev-only).

### Unblocking a red audit gate

In escalation order — there is deliberately **no allowlist file**, because an
allowlist entry is added under deadline pressure and reviewed never:

1. `npm audit fix`, commit the lockfile.
2. Direct bump: `npm i <pkg>@<fixed-version>`.
3. `overrides` in `package.json` when the vulnerable package is transitive and
   its parent has not released — with the removal condition written in a
   comment next to it (`npm ls <pkg>` shows every consumer on the fixed range →
   delete the override).
4. Replace or drop the dependency.
5. Genuinely no fix anywhere (v0.9.0's `extract-zip`, which had no fixed
   version and was only escapable by a major bump of its *parent*): that is a
   judgement call, and it belongs in the PR description where a human reads it,
   not in a config file that silences it forever.

## Project Structure

```
src/
├── tools/        # MCP tool definitions (analyze-video, get-frame-at, get-frame-burst)
├── adapters/     # Platform-specific logic (Loom, direct URL)
├── processors/   # Frame extraction, optimization, dedup, OCR, timeline
├── utils/        # URL detection, VTT parsing, temp files
├── cli.ts        # One-shot `analyze` subcommand (same pipeline, JSON on stdout)
└── types.ts      # Shared TypeScript interfaces
skills/video/     # The portable `video` agent skill (SKILL.md contract)
.claude-plugin/   # Claude Code plugin + marketplace manifests (with root .mcp.json)
```

`skills/` and `.claude-plugin/` are installed from GitHub (Claude Code plugin marketplace / `npx skills add`), not from the npm tarball. The SKILL.md is a public contract: if you change MCP tool names, CLI flags, or the CLI JSON shape, update `skills/video/SKILL.md`, `README.md`, and `AGENTS.md` in the same PR.

## Key Conventions

- **Graceful degradation** — never throw when partial results are available. Add to `warnings[]` and return what you have.
- **No unused exports** — knip enforces this. Run `npm run knip` to check.
- **Two-strategy frame extraction** — yt-dlp+ffmpeg (primary) → headless Chrome (fallback). Both are optional.
- **Never hardcode a container extension in a yt-dlp `-o`** — use `-o <name>.%(ext)s` and glob for `<name>.*`. On a DASH merge yt-dlp appends the real container, so `-o x.mp4` produces `x.mp4.webm` and any `existsSync('x.mp4')` check throws away a download that worked (issue #24).
- **TypeScript strict mode** — no `any` unless explicitly necessary.
- **Every container in `VIDEO_EXTENSIONS` must be decoded by a test** — `test/e2e/video-formats.e2e.test.ts` generates a real clip per container/codec and asserts frames come back. Its drift guard fails if you add an extension to `src/utils/url-detector.ts` without either adding a matrix row or documenting an exclusion.

## Adding a New Platform Adapter

1. Create `src/adapters/your-platform.adapter.ts` implementing `IVideoAdapter`
2. Create `src/adapters/your-platform.adapter.test.ts` with unit tests
3. Register in `src/server.ts` via `registerAdapter()`
4. Add URL pattern detection in `src/utils/url-detector.ts`
5. If the platform downloads via yt-dlp, call `downloadViaYtDlp()` from `src/utils/ytdlp.ts` instead of spawning yt-dlp yourself — it already handles `%(ext)s` output, DASH merging, cookie retry, and `onWarning` reporting. Adapters are siblings: never import one adapter into another
6. Run `npm run check` to verify everything passes

## Before you claim it works

`npm run check` never spawns yt-dlp, never downloads a video, and never installs the package — it can pass on a change that is broken for every user. Run:

```bash
npm run verify-all   # check → e2e → smoke → verify-package
```

Then report what actually ran. Listing commands you meant to run is how a PR ends up claiming coverage it doesn't have.

Two habits that would have caught real bugs here:

- **Prove a regression test fails without your fix.** Revert the fix locally, watch the new test go red, restore. If it stays green, it isn't a regression test. Pull the pre-fix code from git (`git show <commit>^:<path>`) rather than retyping it from memory — the shape you remember is rarely the shape that shipped.
- **Grep for siblings before declaring a bug fixed.** The same broken pattern usually exists in more than one place.

## Updating Examples

The `examples/loom-demo/` folder contains real outputs used as documentation and regression baselines. **Regenerate after any change to tool output format, processors, or adapters:**

```bash
npx tsx examples/generate.ts
```

This downloads the Loom demo video, runs all processors, and saves JSON + frame images. Requires yt-dlp and network access.

## Submitting Changes

1. Fork the repo and create a feature branch
2. Make your changes with tests
3. Run `npm run check` — all checks must pass
4. If you changed tool output format or processors, regenerate examples: `npx tsx examples/generate.ts`
5. Open a pull request with a clear description of what and why

## Reporting Issues

Please include:
- The video URL you tested with (or describe the type — Loom, direct .mp4, etc.)
- The error message or unexpected behavior
- Your Node.js version (`node --version`)
- Whether you have yt-dlp and/or Chrome installed
