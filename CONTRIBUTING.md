# Contributing to mcp-video-analyzer

Thanks for your interest in contributing! This guide will help you get started.

## Setup

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

# Open the MCP Inspector for manual testing
npm run inspect
```

## Running Tests

```bash
npm run test              # Unit tests (fast, no network)
npm run test:coverage     # Unit tests with coverage report
npm run test:e2e          # E2E tests (requires network + yt-dlp/Chrome)
```

Tests live next to their source files: `foo.ts` → `foo.test.ts`.

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
