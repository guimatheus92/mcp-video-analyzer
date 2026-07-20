# CLAUDE.md — Project Instructions for Claude Code

## Project

MCP server for video analysis — extracts transcripts, key frames, metadata, OCR text, and annotated timelines from video URLs (Loom, YouTube and other yt-dlp platforms, direct links) and local video files. The same engine is also exposed as a one-shot CLI (`mcp-video-analyzer analyze <url>`) and as the portable `/video` agent skill (`skills/video/SKILL.md` + Claude Code plugin).

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
- `node dist/index.js analyze <url> [flags]` — run the one-shot CLI against the local build (after `npm run build`)
- `npx tsx examples/generate.ts` — regenerate example outputs (run after changing tool output format, processors, or adapters)

## Architecture

- **Adapters** (`src/adapters/`) — platform-specific logic (Loom GraphQL, yt-dlp platforms [YouTube/Vimeo/TikTok/Instagram/X/Twitch/Dailymotion/Facebook], direct URL download, TwelveLabs, local files). Each implements `IVideoAdapter`. Registered most-specific-first in `server.ts`: Loom → LocalFile → YtDlp → TwelveLabs → Direct.
- **Processors** (`src/processors/`) — shared processing: frame extraction (ffmpeg + browser fallback), image optimization + OCR preprocessing (sharp), frame dedup (dHash, visual + OCR-text-aware), OCR (tesseract.js), audio transcription (whisper), annotated timeline.
- **Tools** (`src/tools/`) — MCP tool definitions registered on the FastMCP server. `analyze-core.ts` holds the shared cache + pipeline (`getAnalysis`) + content builder reused by both `analyze_video` and the batch `analyze_videos`.
- **Utils** (`src/utils/`) — URL detection, VTT parsing, temp files, in-memory + on-disk cache (`cache.ts`, `analysis-sidecar.ts`), bounded concurrency (`concurrency.ts`), env-flag parsing (`env.ts`).
- **CLI** (`src/cli.ts`) — one-shot `analyze` subcommand (`mcp-video-analyzer analyze <url>`) reusing the same `getAnalysis` pipeline: single JSON document on stdout, progress/errors on stderr, frame JPEGs copied to `--out` (default `<tmp>/mcp-video-analyzer/<url-hash>/`) *before* `handle.cleanup()`. `src/index.ts` dispatches on `argv[2]` — no args = MCP stdio server (Docker/smithery/MCP configs rely on this). Adapter registration is shared via `registerAllAdapters()` in `server.ts`. Version literal lives in `src/version.ts`.
- **Skill + plugin** (`skills/video/SKILL.md`, `.claude-plugin/`, root `.mcp.json`) — the `/video` agent skill (Route A: MCP tools; Route B: the CLI via npx) and Claude Code plugin/marketplace manifests; the root `.mcp.json` is the plugin's bundled server config (auto-registered on `/plugin install`). Installed from GitHub, never shipped in the npm tarball (`files: ["dist"]`).

## Conventions

- TypeScript strict mode. No `any` unless explicitly necessary (use `// eslint-disable-next-line`).
- All exports must be used — knip enforces zero unused exports.
- Unit tests live next to source files: `foo.ts` → `foo.test.ts`.
- Shared test infrastructure lives in `test/`: helpers (`test/helpers/`), fixtures (`test/fixtures/`), smoke tests (`test/smoke/`), e2e tests (`test/e2e/`).
- Use `createTestImage()` from `test/helpers/images.ts` and `FIXTURES_DIR` from `test/helpers/fixtures.ts` — don't redefine in each test file.
- Use `vitest` with `pool: 'forks'` (required on Windows).
- Graceful degradation: never throw when partial results are available. Use `warnings[]` array.
- Three-strategy video download: yt-dlp (primary) → direct HTTP via Loom CDN API (fallback) → headless Chrome screenshots (last resort). `LoomAdapter.downloadVideo` **delegates** its yt-dlp strategy to `YtDlpAdapter.downloadVideo` rather than re-implementing it — there is exactly one yt-dlp download call site in `src/`, and it must stay that way (issue #24 was a second, divergent copy).
- **yt-dlp `-o` templates must never hardcode a container extension.** Always `-o <name>.%(ext)s` plus a `readdir` glob for `<name>.*`; when yt-dlp merges separate DASH video+audio streams it appends the REAL container to whatever template you gave it, so `-o x.mp4` writes `x.mp4.webm` and every `existsSync('x.mp4')` after it silently fails on a download that actually succeeded. Pair it with `--ffmpeg-location ffmpegPath` — without that, yt-dlp can't merge at all in our published image (no system ffmpeg) and leaves the streams separate, so the glob can return the audio-only file. Both are enforced by `src/adapters/ytdlp-output-template.test.ts`.
- yt-dlp platform URLs (single-video pages only; playlists/channels rejected) route through `YtDlpAdapter`. `findYtDlp()` (positive probe cached per process) + `runYtDlp()` + `ytdlpCookieArgs()` are shared via `src/utils/ytdlp.ts` — always spawn through `runYtDlp` so the bin/prefix pairing can't be forgotten. Missing yt-dlp surfaces as install-hint warnings: adapter `getTranscript`/`getMetadata` throw `YTDLP_MISSING` and every tool handler catches adapter rejections into `warnings[]`; `downloadVideo` must return `null`, never reject (the pipeline calls it without catch) and reports its failure reason via the optional `onWarning` sink. Native captions preferred (uploaded > auto-generated with rolling-window collapse); `[]` from `getTranscript` strictly means "no captions exist" (fetch failures throw) → Whisper fallback.
- Standard-detail `maxFrames` default is duration-adaptive via `resolveMaxFrames()` in `detail-levels.ts` (~12 for ≤30s up to 60 for >10min). An explicit `maxFrames` always wins and keys the cache separately (`undefined` drops out of the cache key). `get_frames` keeps its fixed default of 20.
- Silent-audio gate: `transcribeAudio()` probes the track with ffmpeg `volumedetect` (first 2 min) before any Whisper strategy; mean volume ≤ −55dB skips transcription with a warning — an empty transcript on a mute track is content, not a bug.
- Frame extraction uses bundled `ffmpeg-static` — no system ffmpeg needed.
- Black frame detection filters out DRM-protected/blank frames automatically.
- Scene detection threshold default: 0.1 (optimized for screencasts/demos). Use `extractKeyFrames()` (not raw `extractSceneFrames`) so static clips with no scene cuts fall back to uniform temporal sampling — critical for talking-head Reels/Stories.
- OCR runs on every frame *before* dedup; when OCR is enabled, dedup uses `dedupeKeepingTextChanges()` (visual + on-screen-text aware) so frames whose only change is the text overlay survive. Plain `deduplicateFrames()` (visual only) is used when OCR is off.
- OCR frames are preprocessed (grayscale + 2× upscale + contrast normalization + sharpen) by default; `MCP_OCR_PREPROCESS=0` disables.
- Transcription strategy order: HF transformers (opt-in) → whisper CLI → OpenAI API. HF only runs when `WHISPER_HF_MODEL` is set, so otherwise the CLI wins and its `WHISPER_MODEL`/`WHISPER_LANGUAGE` settings are never silently overridden. `model`/`language`/`initialPrompt` are overridable per call on `analyze_video`/`analyze_videos`/`get_transcript`.
- The whisper CLI is run directly (no `--help` probe — it double-imports torch and crashes on Windows on non-ASCII help text); `ENOENT` distinguishes "not installed" (try next candidate) from "installed but crashed" (warn). Spawned with `PYTHONUTF8=1`/`PYTHONIOENCODING=utf-8` so multilingual transcripts don't crash the Python stdout codec. When NO backend is configured at all, `transcribeAudio` emits an actionable "No speech-to-text backend available" warning instead of a bare `[]`.
- yt-dlp errors that look auth-related (login/cookies/private/age-restricted/empty-media/rate-limit) get a cookie hint appended by `extractYtDlpError` naming this server's env vars (`YTDLP_COOKIES` / `YTDLP_COOKIES_FROM_BROWSER`), not yt-dlp's raw CLI flags.
- Persistent sidecars (`MCP_WRITE_SIDECARS=1`) write `<stem>.vtt` (Whisper transcripts only, never clobbering an existing one) + `<stem>.analysis.json` + `<stem>.frames/` next to local videos for resumable bulk processing; reads validate `mtime:size` + params.
- CLI mode: stdout is reserved for the single JSON result document — progress, warnings-in-flight, and errors go to stderr. CLI flags validate through the shared `AnalyzeOptionsSchema` (no hand-rolled validation). Partial failures ride in `warnings[]` with exit 0; only hard failures exit 1.
- `skills/video/SKILL.md` is a public contract: any change to MCP tool names, CLI flags, or the CLI JSON shape must update `skills/video/SKILL.md` + `README.md` + `AGENTS.md` in the same PR.
- Tesseract `.traineddata` downloads are cached in `<tmp>/mcp-video-analyzer/tessdata` via `cachePath` (frame-ocr.ts) — never let them land in the process cwd (pollutes the agent's project dir under npx).

## Environment Variables

- **Transcription:** `WHISPER_MODEL`, `WHISPER_LANGUAGE`, `WHISPER_PROMPT` (glossary → `--initial_prompt`), `WHISPER_BIN`, `WHISPER_DEVICE`/`WHISPER_COMPUTE`/`WHISPER_BEAM_SIZE`/`WHISPER_WORD_TIMESTAMPS` (env-gated — only passed to the CLI when set, so `openai-whisper` isn't broken by `whisper-ctranslate2`-only flags), `WHISPER_HF_MODEL` (opt-in), `OPENAI_API_KEY`.
- **OCR:** `MCP_OCR_PREPROCESS` (default on; `0` to disable preprocessing).
- **yt-dlp cookies:** `YTDLP_COOKIES` (Netscape cookie file, wins when both set) / `YTDLP_COOKIES_FROM_BROWSER` (e.g. `chrome`, `edge`) — needed for Instagram and age-restricted videos. Browser extraction requires the browser to be closed on Windows.
- **Sidecars:** `MCP_WRITE_SIDECARS` (default off; `1` to persist resumable sidecars next to local videos).
- **TwelveLabs:** `TWELVELABS_API_KEY` (opt-in Pegasus transcript/summary for direct URLs).

## Publishing

### Release Process

1. **Bump version** in `package.json`, `src/version.ts` AND `.claude-plugin/plugin.json` (must match).
2. **Run checks**: `npm run check` (format, lint, typecheck, knip, tests).
3. **Run smoke test**: `npm run test:smoke` (verifies MCP server starts and responds).
4. **Run package verification**: `npm run verify-package` (packs tarball, installs in temp dir, verifies startup).
5. **Docker image validation** — the `docker-image` CI job runs it on every PR (build from clean clone + ffmpeg present + MCP `initialize` answered), replicating what Glama CI does on each release; `dist/` is gitignored, so the image must compile itself. Confirm the job is green before releasing. Manual fallback: `git archive HEAD -o sim.tar` → extract to an empty dir → `docker build` there → pipe an MCP `initialize` into `docker run -i`. A build that only works with a locally pre-built `dist/` WILL fail on Glama and email the maintainer.
6. **Commit & push**: commit version bump to main.
7. **Publish to npm**: `npm publish`.
8. **Create GitHub release**: `gh release create vX.Y.Z --title "vX.Y.Z" --generate-notes`.
9. **Update local MCP config**: pin the new version in your machine's own MCP client config (NOT the repo-root `.mcp.json`, which is the plugin's bundled server config and stays on `@latest`).
10. **Verify on npm**: `npm view mcp-video-analyzer version`.

### Notes

- Source maps are disabled in tsconfig to reduce package size.
- `npm publish` runs `prepublishOnly` which executes `npm run check && npm run build` automatically.
- Never publish without testing as consumer — `npm run check` passing does NOT mean the package works for end users. Always run `npm run verify-package`.
- The Dockerfile is multi-stage and **self-building** (compiles `src/` in a build stage) — never make it depend on a pre-built `dist/`, and keep `src/` + `tsconfig.json` out of `.dockerignore`. The runtime stage uses `npm ci --omit=dev --ignore-scripts` (the `prepare` script would run tsc without dev deps) followed by `npm rebuild ffmpeg-static` (its postinstall downloads the ffmpeg binary; skipping it ships an image with no frame extraction). Smithery is unaffected (`smithery.yaml` launches via npx).

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
