# CLAUDE.md — Project Instructions for Claude Code

## Project

MCP server for video analysis — extracts transcripts, key frames, metadata, OCR text, and annotated timelines from video URLs (Loom, direct .mp4/.webm).

## Commands

- `npm run check` — run ALL checks (format, lint, typecheck, knip, tests). Always run before committing.
- `npm run build` — compile TypeScript to dist/
- `npm run test` — run unit tests (vitest)
- `npm run test:watch` — run tests in watch mode
- `npm run lint:fix` — auto-fix lint issues
- `npm run format` — auto-format with Prettier
- `npm run inspect` — open FastMCP inspector for manual testing
- `npx tsx examples/generate.ts` — regenerate example outputs (run after changing tool output format, processors, or adapters)

## Architecture

- **Adapters** (`src/adapters/`) — platform-specific logic (Loom GraphQL, direct URL download). Each implements `IVideoAdapter`.
- **Processors** (`src/processors/`) — shared processing: frame extraction (ffmpeg + browser fallback), image optimization (sharp), frame dedup (dHash), OCR (tesseract.js), annotated timeline.
- **Tools** (`src/tools/`) — MCP tool definitions registered on the FastMCP server.
- **Utils** (`src/utils/`) — URL detection, VTT parsing, temp file management.

## Conventions

- TypeScript strict mode. No `any` unless explicitly necessary (use `// eslint-disable-next-line`).
- All exports must be used — knip enforces zero unused exports.
- Tests live next to source files: `foo.ts` → `foo.test.ts`.
- Use `vitest` with `pool: 'forks'` (required on Windows).
- Graceful degradation: never throw when partial results are available. Use `warnings[]` array.
- Two-strategy frame extraction: yt-dlp+ffmpeg (primary) → headless Chrome (fallback). Both are optional.
- Scene detection threshold default: 0.1 (optimized for screencasts/demos).

## Dependencies

- `fastmcp` — MCP server framework
- `sharp` — image processing (resize, compress, dHash computation)
- `ffmpeg-static` — bundled ffmpeg binary for frame extraction
- `puppeteer-core` — browser-based frame extraction fallback (no bundled browser)
- `tesseract.js` — OCR text extraction from frames
- `cheerio` — HTML parsing for adapter scraping

<!-- skilld -->
Before modifying code, evaluate each installed skill against the current task.
For each skill, determine YES/NO relevance and invoke all YES skills before proceeding.
<!-- /skilld -->
