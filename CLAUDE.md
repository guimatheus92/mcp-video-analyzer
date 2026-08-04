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
- Graceful degradation: never throw when partial results are available. Use `warnings[]` array. This includes the frame-only tools (`get_frames`/`get_frame_at`/`get_frame_burst`) **and** `analyze_moment`: a zero-frame outcome — extraction failure, or every extracted frame filtered out as black — returns `frameCount: 0` with the accumulated warnings, never a thrown `UserError` (issue #26). (Dedup can't empty a non-empty set — it always keeps `frame[0]` — so a filtered-to-zero result is always black-frame filtering.) Keep the input-validation throws — `getAdapter`, an invalid timestamp, or `to <= from` all still throw a `UserError`; **validate timestamps up front, outside the extraction `try`**, so both the download and browser strategies see an already-valid value and only the extraction outcome degrades. Wrap only the `extractFrameAt`/`extractFrameBurst` call in `try/catch` (they throw a raw ffmpeg `Error` that leaks the command line, unlike `extractKeyFrames` which degrades to `[]`); surface a fixed, path-free reason, never the caught `e.message`. Both tools' success and degraded paths emit the same JSON `{ frameCount, ..., warnings }` text block so a client can parse either uniformly.
- Three-strategy video download: yt-dlp (primary) → direct HTTP via Loom CDN API (fallback) → headless Chrome screenshots (last resort). **`downloadViaYtDlp()` in `src/utils/ytdlp.ts` is the only yt-dlp download implementation** — both `YtDlpAdapter.downloadVideo` and `LoomAdapter` strategy 1 call it, and it must stay that way (issue #24 was a second, divergent copy that hardcoded `.mp4`). Adapters are siblings behind `IVideoAdapter` and must not depend on each other; shared yt-dlp behaviour belongs in the util.
- **yt-dlp `-o` templates must never hardcode a container extension.** Always `-o <name>.%(ext)s` plus a `readdir` glob for `<name>.*`; when yt-dlp merges separate DASH video+audio streams it appends the REAL container to whatever template you gave it, so `-o x.mp4` writes `x.mp4.webm` and every `existsSync('x.mp4')` after it silently fails on a download that actually succeeded. Pair it with `--ffmpeg-location ffmpegPath` — without that, yt-dlp can't merge at all in our published image (no system ffmpeg) and leaves the streams separate, so the glob can return the audio-only file. The `%(ext)s` rule is enforced repo-wide by `src/adapters/ytdlp-output-template.test.ts` (which also unit-tests its own detector against the original #24 code); the `--ffmpeg-location` argument is asserted in `src/adapters/ytdlp.adapter.test.ts`.
- yt-dlp platform URLs (single-video pages only; playlists/channels rejected) route through `YtDlpAdapter`. `src/utils/ytdlp.ts` owns everything yt-dlp: `findYtDlp()` (positive probe cached per process), `runYtDlp()`, `ytdlpCookieArgs()`, `commonArgs()`, `extractYtDlpError()`, `YTDLP_MISSING` and `downloadViaYtDlp()` — always spawn through `runYtDlp` so the bin/prefix pairing can't be forgotten, and add shared flags to `commonArgs()` rather than inlining them at one call site. The `findYtDlp()` probe uses `YTDLP_PROBE_TIMEOUT` (20s, not 5s): the standalone binary cold-starts in >7s under load, and a shorter timeout made a slow-but-present binary look absent (issue #26). Raising it is nearly free — a genuinely-missing binary rejects via ENOENT in a few ms, never waiting for the timeout. Missing yt-dlp surfaces as install-hint warnings: adapter `getTranscript`/`getMetadata` throw `YTDLP_MISSING` and every tool handler catches adapter rejections into `warnings[]`; `downloadVideo` must return `null`, never reject (the pipeline calls it without catch) and reports its failure reason via the optional `onWarning` sink. Native captions preferred (uploaded > auto-generated with rolling-window collapse); `[]` from `getTranscript` strictly means "no captions exist" (fetch failures throw) → Whisper fallback.
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

## Testing conventions

These three exist because each was violated in the issue #24 fix and caught only in review. They are cheap to follow and expensive to skip.

- **A regression guard must be proven against the real pre-fix code, pulled from git — never against a hand-written example.** The first source guard for #24 blacklisted literal extensions near `-o` and was "verified" by reintroducing the bug inline. The bug had actually been written as `const outputPath = join(destDir, \`${videoId}.mp4\`)` + `-o outputPath`, which the guard passed. Retrieve the real thing (`git show <fix-commit>^:<path>`), run the detector against it, and **pin that snippet as a test case** so the proof lives in the suite instead of in a PR description. Prefer positive assertions ("prove this is safe") over blacklists — "can't prove it" must fail, not pass.
- **A test that cannot fail is worse than no test.** `test/e2e/analyze-loom.e2e.test.ts` asserted `downloadVideo(...) === null` and called it "(no auth)"; it passed whether the code worked or not, which is why a 44MB download being silently discarded went unnoticed for months. Watch for: asserting a null/empty result as the expected outcome, a `catch → skip` broad enough to swallow real failures, and any scan-style guard that asserts nothing when it matches nothing (always assert it scanned something). Guards live in `src/adapters/ytdlp-output-template.test.ts` and `test/e2e/download-destinations.e2e.test.ts`; both unit-test their own detector.
- **When fixing a bug, grep the whole repo for siblings of the pattern before calling it fixed.** The same inverted assertion existed in `test/e2e/partial-results.e2e.test.ts` and shipped untouched in the first pass. One guard in the shared function beats a guard in every caller — and the sibling you don't look for is the one that stays broken.
- **Every core outcome must be asserted against ground-truth fixture content somewhere.** When graceful degradation makes an empty result valid (OCR on a blank clip, transcript on a silent track, dedup on identical frames), at least one test must exist where empty = FAIL: a fixture with *known* text/speech/cuts and an assertion that the pipeline recovered that content. The #28 OCR-downscale bug survived a 500-test suite for months because every fixture was content-free (solid colors, `testsrc`, a black clip) — 0 OCR results was simultaneously "working as designed" and "completely broken". Golden fixtures live in `test/helpers/golden-clips.ts` (ffmpeg drawtext + the OFL font in `test/fixtures/fonts/`); outcome tests in `test/e2e/golden-ocr.e2e.test.ts` and `src/processors/frame-extractor.test.ts`. The transcript half is `test/fixtures/speech.wav` (committed TTS speech; ground truth in `SPEECH_WORDS`) + `test/e2e/golden-transcription.e2e.test.ts`, gated by `WHISPER_E2E=1` because whisper is an external dependency: flag unset = suite visibly skipped (explicit operator opt-out), flag set + whisper missing = **FAIL**, never a probe-and-skip — CI always runs it with `whisper-ctranslate2` via `WHISPER_BIN` (the CLI candidate list is only `[WHISPER_BIN, 'whisper']`). A cousin of this rule guards the analysis cache: every `AnalyzeParams` leaf must be classified result-defining or excluded (`ExcludedFromCacheKey` type guard in `analyze-core.ts` + the `it.each` key table in `analyze-core.test.ts`) — #28's second bug was a result-changing param that silently missed the cache key.

## Verifying a change

`npm run check` is necessary, not sufficient — it never spawns yt-dlp, never downloads, and never installs the package. Run `npm run verify-all` (check → e2e → smoke → verify-package) before claiming a change works, and **report the actual output rather than the list of commands you intended to run**. Set `WHISPER_E2E=1` for the e2e leg when a whisper CLI is installed locally — that's the only way the transcription outcome test runs outside CI. The first #24 PR listed `npm run test:e2e` in its validation section without the full suite ever having been run; the individual files had been run instead.

For anything touching adapters or downloads, also exercise it in a container — `npm run check` passes on a machine that happens to have a system ffmpeg, while the published image has none. The #24 fix needed `--ffmpeg-location` precisely because that difference was invisible on the host.

## Environment Variables

- **Transcription:** `WHISPER_MODEL`, `WHISPER_LANGUAGE`, `WHISPER_PROMPT` (glossary → `--initial_prompt`), `WHISPER_BIN`, `WHISPER_DEVICE`/`WHISPER_COMPUTE`/`WHISPER_BEAM_SIZE`/`WHISPER_WORD_TIMESTAMPS` (env-gated — only passed to the CLI when set, so `openai-whisper` isn't broken by `whisper-ctranslate2`-only flags), `WHISPER_HF_MODEL` (opt-in), `OPENAI_API_KEY`.
- **OCR:** `MCP_OCR_PREPROCESS` (default on; `0` to disable preprocessing). OCR always reads the pre-optimization frame — recognition needs the pixels the emitted copy gives up.
- **Frame size:** `MCP_FRAME_MAX_WIDTH` (default `800`; `0`/`native`/`full`/`original` keeps source resolution) and `MCP_FRAME_JPEG_QUALITY` (default `70`, **no per-call override** — env only). The per-call `maxWidth` tool parameter (six frame-emitting tools) and the CLI's `--max-width` win over `MCP_FRAME_MAX_WIDTH`, and are the right knob for dense UI captures since the server starts once per session. A set-but-invalid value for either is rejected with a one-time stderr warning rather than silently falling back. The *effective* width (per-call → env → default) keys the analysis cache and sidecar, so the same URL at two widths can't serve one result for both — see `keyedFrameMaxWidth()`.
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
