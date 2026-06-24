# CLAUDE.md — Project Instructions for Claude Code

## Project

MCP server for video analysis — extracts transcripts, key frames, metadata, OCR text, and annotated timelines from video URLs (Loom, direct links) and local video files.

## Commands

- `npm run check` — run ALL checks (format, lint, typecheck, knip, tests). Always run before committing.
- `npm run build` — compile TypeScript to dist/
- `npm run test` — run unit tests (vitest)
- `npm run test:watch` — run tests in watch mode
- `npm run test:smoke` — build + verify MCP server starts and responds to initialize
- `npm run verify-package` — build + pack tarball + install in temp dir + verify startup (pre-publish)
- `npm run lint:fix` — auto-fix lint issues
- `npm run format` — auto-format with Prettier
- `npm run inspect` — open FastMCP inspector for manual testing
- `npx tsx examples/generate.ts` — regenerate example outputs (run after changing tool output format, processors, or adapters)

## Architecture

- **Adapters** (`src/adapters/`) — platform-specific logic (Loom GraphQL, direct URL download, TwelveLabs, local files). Each implements `IVideoAdapter`.
- **Processors** (`src/processors/`) — shared processing: frame extraction (ffmpeg + browser fallback), image optimization + OCR preprocessing (sharp), frame dedup (dHash, visual + OCR-text-aware), OCR (tesseract.js), audio transcription (whisper), annotated timeline.
- **Tools** (`src/tools/`) — MCP tool definitions registered on the FastMCP server. `analyze-core.ts` holds the shared cache + pipeline (`getAnalysis`) + content builder reused by both `analyze_video` and the batch `analyze_videos`.
- **Utils** (`src/utils/`) — URL detection, VTT parsing, temp files, in-memory + on-disk cache (`cache.ts`, `analysis-sidecar.ts`), bounded concurrency (`concurrency.ts`), env-flag parsing (`env.ts`).

## Conventions

- TypeScript strict mode. No `any` unless explicitly necessary (use `// eslint-disable-next-line`).
- All exports must be used — knip enforces zero unused exports.
- Unit tests live next to source files: `foo.ts` → `foo.test.ts`.
- Shared test infrastructure lives in `test/`: helpers (`test/helpers/`), fixtures (`test/fixtures/`), smoke tests (`test/smoke/`), e2e tests (`test/e2e/`).
- Use `createTestImage()` from `test/helpers/images.ts` and `FIXTURES_DIR` from `test/helpers/fixtures.ts` — don't redefine in each test file.
- Use `vitest` with `pool: 'forks'` (required on Windows).
- Graceful degradation: never throw when partial results are available. Use `warnings[]` array.
- Three-strategy video download: yt-dlp (primary) → direct HTTP via Loom CDN API (fallback) → headless Chrome screenshots (last resort).
- Frame extraction uses bundled `ffmpeg-static` — no system ffmpeg needed.
- Black frame detection filters out DRM-protected/blank frames automatically.
- Scene detection threshold default: 0.1 (optimized for screencasts/demos). Use `extractKeyFrames()` (not raw `extractSceneFrames`) so static clips with no scene cuts fall back to uniform temporal sampling — critical for talking-head Reels/Stories.
- OCR runs on every frame *before* dedup; when OCR is enabled, dedup uses `dedupeKeepingTextChanges()` (visual + on-screen-text aware) so frames whose only change is the text overlay survive. Plain `deduplicateFrames()` (visual only) is used when OCR is off.
- OCR frames are preprocessed (grayscale + 2× upscale + contrast normalization) by default; `MCP_OCR_PREPROCESS=0` disables.
- Transcription strategy order: whisper CLI → OpenAI API → HF transformers. HF is **opt-in** (only runs when `WHISPER_HF_MODEL` is set) so it never silently overrides CLI model/language settings. `model`/`language`/`initialPrompt` are overridable per call on `analyze_video`/`analyze_videos`/`get_transcript`.
- Persistent sidecars (`MCP_WRITE_SIDECARS=1`) write `<stem>.vtt` (Whisper transcripts only, never clobbering an existing one) + `<stem>.analysis.json` + `<stem>.frames/` next to local videos for resumable bulk processing; reads validate `mtime:size` + params.

## Environment Variables

- **Transcription:** `WHISPER_MODEL`, `WHISPER_LANGUAGE`, `WHISPER_PROMPT` (glossary → `--initial_prompt`), `WHISPER_BIN`, `WHISPER_DEVICE`/`WHISPER_COMPUTE`/`WHISPER_BEAM_SIZE`/`WHISPER_WORD_TIMESTAMPS` (env-gated — only passed to the CLI when set, so `openai-whisper` isn't broken by `whisper-ctranslate2`-only flags), `WHISPER_HF_MODEL` (opt-in), `OPENAI_API_KEY`.
- **OCR:** `MCP_OCR_PREPROCESS` (default on; `0` to disable preprocessing).
- **Sidecars:** `MCP_WRITE_SIDECARS` (default off; `1` to persist resumable sidecars next to local videos).
- **TwelveLabs:** `TWELVELABS_API_KEY` (opt-in Pegasus transcript/summary for direct URLs).

## Publishing

### Release Process

1. **Bump version** in both `package.json` AND `src/server.ts` (must match).
2. **Run checks**: `npm run check` (format, lint, typecheck, knip, tests).
3. **Run smoke test**: `npm run test:smoke` (verifies MCP server starts and responds).
4. **Run package verification**: `npm run verify-package` (packs tarball, installs in temp dir, verifies startup).
5. **Commit & push**: commit version bump to main.
6. **Publish to npm**: `npm publish`.
7. **Create GitHub release**: `gh release create vX.Y.Z --title "vX.Y.Z" --generate-notes`.
8. **Update .mcp.json**: pin new version in local MCP config.
9. **Verify on npm**: `npm view mcp-video-analyzer version`.

### Notes

- Source maps are disabled in tsconfig to reduce package size.
- `npm publish` runs `prepublishOnly` which executes `npm run check && npm run build` automatically.
- Never publish without testing as consumer — `npm run check` passing does NOT mean the package works for end users. Always run `npm run verify-package`.

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
