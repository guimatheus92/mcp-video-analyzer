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
└── types.ts      # Shared TypeScript interfaces
```

## Key Conventions

- **Graceful degradation** — never throw when partial results are available. Add to `warnings[]` and return what you have.
- **No unused exports** — knip enforces this. Run `npm run knip` to check.
- **Two-strategy frame extraction** — yt-dlp+ffmpeg (primary) → headless Chrome (fallback). Both are optional.
- **TypeScript strict mode** — no `any` unless explicitly necessary.

## Adding a New Platform Adapter

1. Create `src/adapters/your-platform.adapter.ts` implementing `IVideoAdapter`
2. Create `src/adapters/your-platform.adapter.test.ts` with unit tests
3. Register in `src/server.ts` via `registerAdapter()`
4. Add URL pattern detection in `src/utils/url-detector.ts`
5. Run `npm run check` to verify everything passes

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
