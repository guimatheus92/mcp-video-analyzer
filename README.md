<p align="center">
  <img src="assets/icon.svg" width="88" height="88" alt="mcp-video-analyzer" />
</p>

<h1 align="center">mcp-video-analyzer</h1>

<p align="center"><em>Turn any video — YouTube, Instagram, TikTok, Loom, X, Vimeo, direct links, local files — into transcripts, key frames, OCR text, and metadata for AI agents.</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/mcp-video-analyzer"><img src="https://img.shields.io/npm/v/mcp-video-analyzer?color=e8468f&labelColor=1e1e2e&logo=npm&logoColor=white" alt="npm" /></a>
  <a href="https://github.com/guimatheus92/mcp-video-analyzer/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/mcp-video-analyzer?color=8b5cf6&labelColor=1e1e2e" alt="license" /></a>
  <a href="https://github.com/punkpeye/awesome-mcp-servers#-multimedia-process"><img src="https://img.shields.io/badge/awesome--mcp--servers-listed-ff4d6d?labelColor=1e1e2e" alt="awesome-mcp-servers" /></a>
  <a href="https://mcpservers.org/servers/guimatheus92/mcp-video-analyzer"><img src="https://img.shields.io/badge/mcpservers.org-listed-38bdf8?labelColor=1e1e2e" alt="mcpservers.org" /></a>
</p>

<p align="center">
  <a href="https://glama.ai/mcp/servers/guimatheus92/mcp-video-analyzer"><img width="360" height="190" src="https://glama.ai/mcp/servers/guimatheus92/mcp-video-analyzer/badge" alt="mcp-video-analyzer MCP server" /></a>
</p>

No existing video MCP combines **transcripts + visual frames + metadata** in one tool. This one does — across Loom, the major yt-dlp platforms (YouTube/Vimeo/TikTok/Instagram/X/Twitch/Dailymotion/Facebook), direct video URLs, and local files.

> **Want a full pipeline, not just a tool?** [social-knowledge-base](https://github.com/guimatheus92/social-knowledge-base) is built on top of this server — it downloads whole Instagram creator accounts (reels, stories, highlights), transcribes them, and turns the result into a searchable, RAG-queryable knowledge base with AI-generated notes. Use this MCP when you want per-video analysis inside an agent; use social-knowledge-base when you want to archive and query an entire account.

## Installation

### Prerequisites

- **Node.js 18+** — required to run the server via `npx`
- **yt-dlp** — **required** for YouTube/Vimeo/TikTok/Instagram/X/Twitch/Dailymotion/Facebook URLs; optional for everything else (improves Loom download quality). Install with `pip install yt-dlp`
- **Chrome/Chromium** (optional) — fallback for frame extraction if yt-dlp is unavailable

> Without yt-dlp or Chrome, direct URLs and local files still get frames — the bundled `ffmpeg-static` does the extraction, and Loom falls back to its own CDN download. Platform URLs (YouTube etc.) degrade to a clear "install yt-dlp" warning. Transcripts, metadata, and comments never require either.

There are three ways in: the **`/video` plugin** (Claude Code — slash command + MCP server auto-configured), a plain **MCP server** config (any MCP client), or the **portable skill + CLI** (Codex, Cursor, Copilot, and any agent with a shell — no MCP required).

### Claude Code — `/video` plugin (recommended)

```
/plugin marketplace add guimatheus92/mcp-video-analyzer
/plugin install video@mcp-video-analyzer
```

This adds the `/video` slash command **and** auto-registers the MCP server — no `claude mcp add` needed:

```
/video https://youtu.be/jNQXAC9IVRw what happens at 0:10?
/video ~/Movies/screen-recording.mp4 when does the UI break?
```

### Other agents — Codex, Cursor, Copilot, Gemini CLI, …

```bash
npx skills add guimatheus92/mcp-video-analyzer
```

Installs the `video` skill ([Agent Skills](https://github.com/vercel-labs/skills) format) into every agent detected on your machine. Agents without the MCP server configured fall back to the bundled [CLI](#cli-one-shot-no-mcp-client) automatically — zero configuration.

### Claude Code (MCP only)

```bash
claude mcp add video-analyzer -- npx mcp-video-analyzer@latest
```

Then restart Claude Code or start a new conversation.

### VS Code / Cursor

Add to your MCP settings file:

- **VS Code**: `File → Preferences → Settings → search "MCP"` or edit `~/.vscode/mcp.json` / `%APPDATA%\Code\User\mcp.json` (Windows)
- **Cursor**: `Settings → MCP Servers → Add`

```json
{
  "servers": {
    "mcp-video-analyzer": {
      "type": "stdio",
      "command": "npx",
      "args": ["mcp-video-analyzer@latest"]
    }
  }
}
```

Then reload the window (`Ctrl+Shift+P` → "Developer: Reload Window").

### Claude Desktop

Add to your Claude Desktop config file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "video-analyzer": {
      "command": "npx",
      "args": ["mcp-video-analyzer@latest"]
    }
  }
}
```

Then restart Claude Desktop.

### CLI (one-shot, no MCP client)

The same engine is exposed as a one-shot command — this is what the `video` skill uses on agents without MCP, and it works standalone in any terminal:

```bash
npx -y mcp-video-analyzer@latest analyze "https://youtu.be/jNQXAC9IVRw"
```

stdout is a single JSON document — `metadata`, `transcript`, `ocrResults`, `timeline`, `warnings`, `frameCount`, and `frames` as `{ time, filePath, mimeType }` entries pointing at JPEG key frames copied to `--out` (default: `<tmp>/mcp-video-analyzer/<url-hash>/`). Progress streams on stderr, so `stdout` can be piped straight into a JSON parser. Partial failures land in `warnings` with exit code 0; only hard failures exit 1.

| Flag | Description |
|------|-------------|
| `--detail <level>` | `brief` (metadata + transcript, no frames), `standard` (default), `detailed` |
| `--max-frames <n>` | Max key frames, 1–60 (default adapts to duration) |
| `--fields <list>` | Output filter — comma-separated subset: `metadata,transcript,frames,comments,chapters,ocrResults,timeline,aiSummary`. Filters the emitted JSON only; use `--detail brief` to actually skip download/frame extraction |
| `--force-refresh` | Bypass the cache and re-analyze |
| `--ocr-language <codes>` | Tesseract languages (default `eng+por`) |
| `--model <name>` / `--language <code>` | Whisper overrides for the transcription fallback |
| `--out <dir>` | Where frame images are copied |

Run with no arguments (`npx mcp-video-analyzer@latest`) to start the MCP stdio server — the CLI is purely additive.

### Verify it works

Once installed, ask your AI assistant:

```
Analyze this video: https://www.youtube.com/watch?v=jNQXAC9IVRw
```

(also works with an Instagram/TikTok/Loom link, a direct `.mp4` URL, or a local file path). If the server is connected, it will automatically call the `analyze_video` tool.

## Tools

Eight tools — the AI picks the cheapest one for the job and calls it automatically. Click any tool to expand its parameters and examples.

| Tool | What it does |
|------|--------------|
| **`analyze_video`** | Full analysis: transcript + key frames + OCR + timeline + metadata |
| **`analyze_videos`** | Batch version, one structured result per source (resumable) |
| **`get_transcript`** | Transcript only (native captions or Whisper fallback) |
| **`get_metadata`** | Metadata + comments + chapters, no download |
| **`get_frames`** | Key frames only (scene-change or dense 1 fps) |
| **`analyze_moment`** | Deep-dive on a time range (burst frames + transcript + OCR) |
| **`get_frame_at`** | Single frame at a timestamp |
| **`get_frame_burst`** | N frames across a narrow window (motion/animation) |

<details>
<summary><b><code>analyze_video</code></b> — full video analysis</summary>

<br>

Extracts everything from a video URL in one call:

```
> Analyze this video: https://www.youtube.com/watch?v=abc123...
```

Returns:
- **Transcript** with timestamps and speakers
- **Key frames** extracted via scene-change detection (automatically deduplicated). For static clips with no scene cuts — e.g. talking-head Reels/Stories where only an on-screen text overlay changes — it automatically falls back to uniform temporal sampling so you still get frames (and OCR) instead of an empty result.
- **OCR text** extracted from frames (code, error messages, UI text, prices/dates/CTAs visible on screen)
- **Annotated timeline** merging transcript + frames + OCR into a unified "what happened when" view
- **Metadata** (title, duration, platform)
- **Comments** from viewers
- **Chapters** and **AI summary** (when available)

The AI will **automatically** call this tool when it sees a video URL — no need to ask.

Options:
- `detail` — analysis depth: `"brief"` (metadata + truncated transcript, no frames), `"standard"` (default), `"detailed"` (dense sampling, more frames)
- `fields` — array of specific fields to return, e.g. `["metadata", "transcript"]`. Available: `metadata`, `transcript`, `frames`, `comments`, `chapters`, `ocrResults`, `timeline`, `aiSummary`
- `maxFrames` (1-60) — cap on extracted frames. Default scales with video duration at `standard` detail (~12 for ≤30s up to 60 for >10min); fixed 60 at `detailed`, 0 at `brief`. An explicit value always wins
- `threshold` (0.0-1.0, default 0.1) — scene-change sensitivity
- `forceRefresh` — bypass cache and re-analyze
- `skipFrames` — skip frame extraction for transcript-only analysis
- `model` / `language` / `initialPrompt` — per-call Whisper overrides for the transcription fallback (override `WHISPER_MODEL` / `WHISPER_LANGUAGE` / `WHISPER_PROMPT` for this call only — pick a heavier model or a domain glossary for one hard clip without restarting the server)

</details>

<details>
<summary><b><code>analyze_videos</code></b> — batch analysis</summary>

<br>

```
> Analyze every .mp4 in this folder
```

Runs `analyze_video` over a list of `sources` with a `concurrency` limit (default 2), returning one **structured result per source** — counts + warnings on success, or a per-item `error` on failure (one bad file never aborts the batch). Frame images are not inlined and full transcript/OCR/timeline are returned only when `fields` is set; otherwise you get counts. Pair with `MCP_WRITE_SIDECARS=1` (below) so each video's result persists to disk and a re-run resumes instead of recomputing.

</details>

<details>
<summary><b><code>get_transcript</code></b> — transcript only</summary>

<br>

```
> Get the transcript from this video
```

Quick transcript extraction. Falls back to Whisper transcription when no native transcript is available. Accepts the same per-call `model` / `language` / `initialPrompt` overrides as `analyze_video`.

</details>

<details>
<summary><b><code>get_metadata</code></b> — metadata only</summary>

<br>

```
> What's this video about?
```

Returns metadata, comments, chapters, and AI summary without downloading the video.

</details>

<details>
<summary><b><code>get_frames</code></b> — frames only</summary>

<br>

```
> Extract frames from this video with dense sampling
```

Two modes:
- **Scene-change detection** (default) — captures visual transitions
- **Dense sampling** (`dense: true`) — 1 frame/sec for full coverage

</details>

<details>
<summary><b><code>analyze_moment</code></b> — deep-dive on a time range</summary>

<br>

```
> Analyze what happens between 1:30 and 2:00 in this video
```

Combines burst frame extraction + filtered transcript + OCR + annotated timeline for a focused segment. Use when you need to understand exactly what happens at a specific moment.

</details>

<details>
<summary><b><code>get_frame_at</code></b> — single frame at a timestamp</summary>

<br>

```
> Show me the frame at 1:23 in this video
```

The AI reads the transcript, spots a critical moment, and requests the exact frame to see what's on screen.

</details>

<details>
<summary><b><code>get_frame_burst</code></b> — N frames in a time range</summary>

<br>

```
> Show me 10 frames between 0:15 and 0:17 of this video
```

For motion, vibration, animations, or fast scrolling — burst mode captures N frames in a narrow window so the AI can see frame-by-frame changes.

</details>

## Detail Levels

| Level | Frames | Transcript | OCR | Timeline | Use case |
|-------|--------|-----------|-----|----------|----------|
| `brief` | None | First 10 entries | No | No | Quick check — what's this video about? |
| `standard` | Duration-adaptive: ~12 (≤30s) up to 60 (>10min), scene-change | Full | Yes | Yes | Default — full analysis |
| `detailed` | Up to 60 (1fps dense) | Full | Yes | Yes | Deep analysis — every second captured |

## Caching

Results are cached in memory for 10 minutes. Subsequent calls with the same URL and options return instantly. Use `forceRefresh: true` to bypass the cache.

### Persistent sidecars (resumable bulk processing)

The in-memory cache is lost on restart, which makes reprocessing a large local corpus costly. Set `MCP_WRITE_SIDECARS=1` to also persist results **next to each local video** so the work survives restarts and can resume:

- `<stem>.vtt` — the transcript, **only** when it was generated by the Whisper fallback (an existing `<stem>.vtt` from your own pipeline is never overwritten). A later call reuses it via the normal sidecar reader and skips Whisper entirely.
- `<stem>.analysis.json` + `<stem>.frames/` — the full result (frames + OCR + timeline), keyed by the video's `mtime:size` and the analysis params. On a later call with a matching stamp + params, the result is returned straight from disk (no extraction, no OCR).

This makes `analyze_videos` over thousands of files resumable, and lets an external GPU transcription pipeline and this MCP share results through the filesystem: the pipeline writes `<stem>.vtt`, and the MCP picks it up instead of running Whisper.

## Supported Sources

| Source | Transcript | Metadata | Comments | Frames | Auth |
|--------|:----------:|:--------:|:--------:|:------:|:----:|
| **Loom** | Yes | Yes | Yes | Yes (needs yt-dlp — see note) | None |
| **YouTube / Vimeo / TikTok / Instagram / X / Twitch / Dailymotion / Facebook** | Native captions (uploaded > auto-generated) or Whisper fallback | Yes (title, duration, uploader, views, chapters, upload date) | No | Yes (capped at 1080p) | yt-dlp installed; cookies for Instagram / age-restricted (see below) |
| **Direct URL** (.mp4, .mov, .mkv, .webm, …) | No | Duration only | No | Yes | None |
| **Direct URL + TwelveLabs** | Yes (Pegasus, best-effort) | Duration floor + title | No | Yes | `TWELVELABS_API_KEY` |
| **Local file** (absolute path or `file://` URI) | Sidecar `.vtt`/`.srt` or Whisper fallback | Probed via ffmpeg (duration, dims, codec, audio presence) | No | Yes | None |

> **Loom frames**: transcript, metadata, and comments come straight from Loom's API with no extra tooling. Frame extraction is different — Loom serves most videos as separate DASH video+audio streams, so it needs [yt-dlp](https://github.com/yt-dlp/yt-dlp) (`pip install yt-dlp`) to fetch and merge them. Merging itself uses the bundled `ffmpeg-static`, so no system ffmpeg is required. Without yt-dlp you still get transcript + metadata + comments, plus a warning saying why frames are missing.
>
> **Local files**: pass an absolute path (e.g., `/Users/you/clip.mp4`) or a `file://` URI as the `url` argument to any tool. Relative paths are rejected — the server's working directory is unpredictable from the MCP client. Note that any caller of the MCP server can ask it to read any file the server process has access to.
>
> **Sidecar transcripts**: if a `clip.vtt`, `clip.srt`, `clip.en.vtt`, etc. lives next to `clip.mp4`, it's used as the transcript automatically — no Whisper roundtrip needed. SRT is converted to VTT in-memory.
>
> **Embedded subtitles**: if no sidecar is found and the container has an embedded subtitle stream (common in `.mkv` / `.mov` / `.mp4` from screen recorders), it's transmuxed to VTT via ffmpeg and used as the transcript.
>
> **Recognized extensions** (local files and direct URLs): `.mp4` `.mov` `.mkv` `.webm` `.avi` `.m4v` `.wmv` `.flv` `.mpeg` `.mpg` `.m2ts` `.mts` `.3gp` `.ogv`. The extension only gates routing — ffmpeg does the actual demuxing, so most common containers work. `.ts` is excluded to avoid colliding with TypeScript source files.

### Platform URLs via yt-dlp (YouTube, Instagram, TikTok, …)

Single-video pages on major platforms route through [yt-dlp](https://github.com/yt-dlp/yt-dlp) (`pip install yt-dlp` — required for these URLs). Playlists, channels, and profile pages are rejected by design; pass individual video URLs (batch them with `analyze_videos`).

- **Transcript**: native captions are preferred and free — uploaded subtitles first, auto-generated captions as fallback (rolling-window duplication is collapsed). `WHISPER_LANGUAGE` (e.g. `pt`) is also used to pick the caption language. Videos with no captions at all fall through to the normal Whisper chain.
- **Metadata**: title, duration, uploader/channel, view count, upload date, and chapters — no download needed.
- **Download**: capped at 1080p (frames/OCR don't need more), live streams are skipped, and DASH audio+video is merged with the bundled `ffmpeg-static` (no system ffmpeg required).
- **Cookies** — Instagram and age-restricted videos usually require a logged-in session:

| Env var | What it does | Example |
|---------|-------------|---------|
| `YTDLP_COOKIES` | Cookie file (Netscape format), wins when both are set | `C:/secrets/cookies.txt` |
| `YTDLP_COOKIES_FROM_BROWSER` | Extract cookies from an installed browser | `chrome`, `edge`, `firefox` |

> Browser cookie extraction requires the browser to be **closed** on Windows (the cookie database is locked while it runs). If that's inconvenient, export a `cookies.txt` once (e.g. with a "Get cookies.txt" browser extension) and point `YTDLP_COOKIES` at it. Private/age-restricted videos without valid cookies don't crash the tool — the yt-dlp `ERROR:` line surfaces in `warnings[]`.

### TwelveLabs Pegasus (optional)

Set the `TWELVELABS_API_KEY` environment variable to analyze direct video URLs with [TwelveLabs](https://twelvelabs.io) **Pegasus**. Pegasus analyzes the video server-side (visuals **and** its own audio) and returns an **AI-generated, timestamped transcript** plus an AI summary as text — capabilities the `DirectAdapter` can't provide (a raw `.mp4` URL has no transcript or summary on its own), and with **no Whisper key required**.

The transcript is best-effort LLM output, not a deterministic ASR dump: Pegasus is *prompted* to emit `[MM:SS] line` rows, and lines that don't match that shape are dropped, so wording and exact timestamps depend on the model's prompt adherence. Failures (bad key, timeout, API error) surface in the tool's `warnings[]` rather than silently returning an empty transcript.

The biggest win is on the text-only paths: `get_transcript` and `get_metadata` return a Pegasus transcript and summary for direct URLs — a few KB of text, no frame images, no per-frame token cost. `analyze_video` at `detail: "standard"`/`"detailed"` still extracts frames in addition (use `detail: "brief"` to stay text-only).

> **Long videos**: the summary and full transcript share a single capped completion (`max_tokens` = 16384), so for very long videos the transcript may be truncated. For multi-hour content, chunking by time window is the better approach.

It's fully opt-in and non-breaking: when `TWELVELABS_API_KEY` is set the `TwelveLabsAdapter` handles direct video URLs (it registers the public URL with TwelveLabs — no upload); when it's unset, the `DirectAdapter` handles them exactly as before. Loom URLs are unaffected. Get a key at [playground.twelvelabs.io](https://playground.twelvelabs.io).

### Transcription (Whisper fallback)

When a source has no native transcript (no sidecar `.vtt`/`.srt`, no embedded subtitles, no platform captions), the audio track is transcribed with Whisper via a graceful fallback chain (in execution order):

> **Silent tracks**: before any Whisper run, the audio is probed with ffmpeg `volumedetect` (first 2 minutes). A present-but-mute track — common in muted Reels/Stories — skips transcription entirely and emits a warning that the empty transcript is **expected content, not an error**, saving a pointless Whisper run.

1. **@huggingface/transformers** (JS-native, zero external deps) — **opt-in only**: this strategy runs *first*, but **only when `WHISPER_HF_MODEL` is explicitly set**. When it's unset (the default) the strategy is skipped entirely, so the CLI below wins and its `WHISPER_MODEL`/`WHISPER_LANGUAGE` settings are never silently overridden.
2. **`whisper` CLI** — used when a `whisper` executable is found (`pip install -U openai-whisper`). Point `WHISPER_BIN` at the executable if it isn't on `PATH`. Model via `WHISPER_MODEL`, language via `WHISPER_LANGUAGE`. The bundled `ffmpeg-static` is put on the CLI's `PATH` automatically, so no system ffmpeg is required.
3. **OpenAI Whisper API** — used when `OPENAI_API_KEY` is set.

> **No backend configured?** If none of the three is available (no `whisper` on `PATH`/`WHISPER_BIN`, no `OPENAI_API_KEY`, no `WHISPER_HF_MODEL`), transcription tools return an empty transcript **with a warning telling you how to enable one** — rather than a silent "no transcript". Install `openai-whisper` or set one of the keys above. (The CLI is spawned with `PYTHONUTF8=1` so non-English/CJK transcripts don't crash the Python process on Windows.)

| Env var | Applies to | Default | Example |
|---------|-----------|---------|---------|
| `WHISPER_MODEL` | `whisper` CLI | `tiny` | `small`, `medium` |
| `WHISPER_LANGUAGE` | `whisper` CLI / OpenAI API | auto-detect | `pt`, `en`, `es` |
| `WHISPER_PROMPT` | `whisper` CLI / OpenAI API | — | `Doha, Smiles, Livelo, Latam, milheiro` |
| `WHISPER_BIN` | `whisper` CLI | `whisper` (on PATH) | `C:/.../Scripts/whisper.exe` |
| `WHISPER_DEVICE` | `whisper` CLI (sent only if set) | — | `cuda`, `cpu` |
| `WHISPER_COMPUTE` | `whisper-ctranslate2` only | — | `float16`, `int8_float16`, `int8` |
| `WHISPER_BEAM_SIZE` | `whisper` CLI (sent only if set) | — | `5` |
| `WHISPER_WORD_TIMESTAMPS` | `whisper` CLI (sent only if set) | off | `1` |
| `WHISPER_HF_MODEL` | HF transformers (opt-in) | — (strategy off) | `Xenova/whisper-small` |
| `OPENAI_API_KEY` | OpenAI API | — | `sk-…` |

> The default `tiny` model is fast but weak for non-English audio. For Portuguese (or other non-English) sources, install the CLI and set `WHISPER_MODEL=small` (or `medium`) + `WHISPER_LANGUAGE=pt` for much better accuracy. Add `WHISPER_PROMPT` with a domain glossary (brand/place names) to fix proper nouns. You can also override `model`/`language`/`initialPrompt` **per call** on `analyze_video` / `get_transcript` / `analyze_videos` — no restart needed.
>
> **GPU (faster-whisper):** `whisper-ctranslate2` (`pip install -U whisper-ctranslate2`) is a drop-in CLI with the same flags plus `--device cuda` / `--compute_type` / `--beam_size`. Point `WHISPER_BIN` at it and set `WHISPER_DEVICE=cuda` (+ optionally `WHISPER_COMPUTE=float16`). These GPU flags are **env-gated** — they're only passed when set, so plain `openai-whisper` (which rejects `--compute_type`) keeps working when they're unset.
>
> **Windows note:** pip installs `whisper.exe` into the Python `Scripts/` dir, which is often **not** on the `PATH` that GUI-launched MCP clients inherit. If transcripts come back empty, set `WHISPER_BIN` to the full path of `whisper.exe`.

### Frame Extraction Strategies

Frame extraction uses a two-strategy fallback chain — no single dependency is required:

| Strategy | How it works | Speed | Requirements |
|----------|-------------|-------|-------------|
| **yt-dlp + ffmpeg** (primary) | Downloads video, extracts frames via scene detection | Fast, precise | [yt-dlp](https://github.com/yt-dlp/yt-dlp) (`pip install yt-dlp`) |
| **Browser** (fallback) | Opens video in headless Chrome, seeks to timestamps, takes screenshots | Slower, no download needed | Chrome or Chromium installed |

The fallback is automatic — if yt-dlp is not available, the server tries browser-based extraction via `puppeteer-core`. If neither is available, analysis still returns transcript + metadata + comments, just no frames.

### Post-Processing Pipeline

After frame extraction, the pipeline automatically applies:

| Step | What it does | Why |
|------|-------------|-----|
| **Frame deduplication** | Removes near-identical consecutive frames using perceptual hashing (dHash + Hamming distance) | Screencasts often have long static moments — dedup removes redundant frames, saving tokens |
| **OCR** | Extracts text visible on screen from each frame (via tesseract.js). Each frame is first preprocessed — grayscale + 2× upscale + contrast normalization + sharpen — which materially improves accuracy on stylized overlays (prices, dates, coupons, CTAs). | Captures code, error messages, terminal output, UI text that the transcript doesn't cover |
| **Annotated timeline** | Merges transcript timestamps + frame timestamps + OCR text into a single chronological view | Gives the AI a unified "what was said, what changed visually, and what text appeared" at each moment |

The OCR step requires `tesseract.js` (included as a dependency). If it fails to load, analysis continues without OCR — no frames or transcript are lost. OCR preprocessing is on by default; set `MCP_OCR_PREPROCESS=0` to OCR the raw frames instead.

## Complementary Tools

### Chrome DevTools MCP

For **live web debugging** alongside video analysis, pair this server with the [Chrome DevTools MCP](https://github.com/anthropics/anthropic-quickstarts/tree/main/mcp-devtools):

```bash
claude mcp add chrome-devtools npx @anthropic-ai/mcp-devtools@latest
```

**When to use each:**

| Scenario | Tool |
|----------|------|
| Bug report recorded as a Loom video | `mcp-video-analyzer` — extract transcript, frames, and error text from the recording |
| Live debugging a web page | Chrome DevTools MCP — inspect DOM, console, network, take screenshots |
| Video shows UI issue, need to reproduce it | Use both: analyze the video first, then open the page in Chrome DevTools to reproduce |

The two MCPs complement each other: video analyzer understands **recorded** content, DevTools interacts with **live** pages.

## Example Output

The [`examples/loom-demo/`](examples/loom-demo/) folder contains **real outputs** from analyzing a public Loom video ([Boost In-App Demo Video](https://www.loom.com/share/bdebdfe44b294225ac718bad241a94fe), 2:55).

| File | What it shows |
|------|--------------|
| [`metadata.json`](examples/loom-demo/metadata.json) | Title, duration, platform |
| [`transcript.json`](examples/loom-demo/transcript.json) | 42 timestamped entries with speaker IDs |
| [`timeline.json`](examples/loom-demo/timeline.json) | Unified chronological view (transcript + frames merged) |
| [`moment-transcript-0m30s-0m45s.json`](examples/loom-demo/moment-transcript-0m30s-0m45s.json) | Filtered transcript for `analyze_moment` (0:30–0:45) |
| [`full-analysis.json`](examples/loom-demo/full-analysis.json) | Complete `analyze_video` output |

**Frame images** (19 total in [`examples/loom-demo/frames/`](examples/loom-demo/frames/)):
- `scene_*.jpg` — scene-change detection (key visual transitions)
- `dense_*.jpg` — 1fps dense sampling (every 10th frame saved as sample)
- `burst_*.jpg` — burst extraction for moment analysis (0:30–0:45)

> **Regenerate after changes:** `npx tsx examples/generate.ts` — requires yt-dlp + network access.

## Development

```bash
# Install dependencies
npm install

# Run all checks (format, lint, typecheck, knip, tests)
npm run check

# Build
npm run build

# Run E2E tests (requires network)
npm run test:e2e

# Open MCP Inspector for manual testing
npm run inspect
```

## Architecture

```
src/
├── index.ts                    # Entry point (shebang + stdio)
├── server.ts                   # FastMCP server + tool registration
├── tools/                      # MCP tool definitions (7 tools)
│   ├── analyze-video.ts        # Full analysis with detail levels + caching
│   ├── analyze-moment.ts       # Deep-dive on a time range
│   ├── get-transcript.ts       # Transcript-only with Whisper fallback
│   ├── get-metadata.ts         # Metadata + comments + chapters
│   ├── get-frames.ts           # Frames-only (scene-change or dense)
│   ├── get-frame-at.ts         # Single frame at timestamp
│   └── get-frame-burst.ts      # N frames in a time range
├── adapters/                   # Source-specific logic
│   ├── adapter.interface.ts    # IVideoAdapter interface + registry
│   ├── loom.adapter.ts         # Loom: authless GraphQL
│   ├── local-file.adapter.ts   # Local files: absolute path or file:// URI
│   ├── twelvelabs.adapter.ts   # TwelveLabs Pegasus: transcript + AI summary (opt-in)
│   └── direct.adapter.ts       # Direct URL: any mp4/webm link
├── processors/                 # Shared processing
│   ├── frame-extractor.ts      # ffmpeg scene detection + dense + burst extraction
│   ├── browser-frame-extractor.ts # Headless Chrome fallback for frames
│   ├── audio-transcriber.ts    # Whisper fallback (HF transformers → CLI → OpenAI)
│   ├── image-optimizer.ts      # sharp resize/compress
│   ├── frame-dedup.ts          # Perceptual dedup (dHash + Hamming distance)
│   ├── frame-ocr.ts            # OCR text extraction (tesseract.js)
│   └── annotated-timeline.ts   # Unified timeline (transcript + frames + OCR)
├── config/
│   └── detail-levels.ts        # brief / standard / detailed config
├── utils/
│   ├── cache.ts                # In-memory TTL cache with LRU eviction
│   ├── field-filter.ts         # Selective field filtering for responses
│   ├── url-detector.ts         # Platform detection from URL
│   ├── vtt-parser.ts           # WebVTT → transcript entries
│   └── temp-files.ts           # Temp directory management
└── types.ts                    # Shared TypeScript interfaces
```

## License

MIT
