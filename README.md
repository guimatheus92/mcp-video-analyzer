# mcp-video-analyzer

<a href="https://glama.ai/mcp/servers/guimatheus92/mcp-video-analyzer">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/guimatheus92/mcp-video-analyzer/badge" alt="mcp-video-analyzer MCP server" />
</a>

Featured in [awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers#-multimedia-process).

MCP server for video analysis — extracts transcripts, key frames, and metadata from video URLs and local video files. Supports Loom, direct video URLs (.mp4, .mov, .mkv, .webm, and other common formats), and absolute paths to local video files.

No existing video MCP combines **transcripts + visual frames + metadata** in one tool. This one does.

## Installation

### Prerequisites

- **Node.js 18+** — required to run the server via `npx`
- **yt-dlp** (optional) — enables frame extraction via ffmpeg. Install with `pip install yt-dlp`
- **Chrome/Chromium** (optional) — fallback for frame extraction if yt-dlp is unavailable

> Without yt-dlp or Chrome, the server still works — you'll get transcripts, metadata, and comments, just no frames.

### Claude Code (CLI)

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

### Verify it works

Once installed, ask your AI assistant:

```
Analyze this video: https://www.loom.com/share/bdebdfe44b294225ac718bad241a94fe
```

If the server is connected, it will automatically call the `analyze_video` tool.

## Tools

### `analyze_video` — Full video analysis

Extracts everything from a video URL in one call:

```
> Analyze this video: https://www.loom.com/share/abc123...
```

Returns:
- **Transcript** with timestamps and speakers
- **Key frames** extracted via scene-change detection (automatically deduplicated)
- **OCR text** extracted from frames (code, error messages, UI text visible on screen)
- **Annotated timeline** merging transcript + frames + OCR into a unified "what happened when" view
- **Metadata** (title, duration, platform)
- **Comments** from viewers
- **Chapters** and **AI summary** (when available)

The AI will **automatically** call this tool when it sees a video URL — no need to ask.

Options:
- `detail` — analysis depth: `"brief"` (metadata + truncated transcript, no frames), `"standard"` (default), `"detailed"` (dense sampling, more frames)
- `fields` — array of specific fields to return, e.g. `["metadata", "transcript"]`. Available: `metadata`, `transcript`, `frames`, `comments`, `chapters`, `ocrResults`, `timeline`, `aiSummary`
- `maxFrames` (1-60, default depends on detail level) — cap on extracted frames
- `threshold` (0.0-1.0, default 0.1) — scene-change sensitivity
- `forceRefresh` — bypass cache and re-analyze
- `skipFrames` — skip frame extraction for transcript-only analysis

### `get_transcript` — Transcript only

```
> Get the transcript from this video
```

Quick transcript extraction. Falls back to Whisper transcription when no native transcript is available.

### `get_metadata` — Metadata only

```
> What's this video about?
```

Returns metadata, comments, chapters, and AI summary without downloading the video.

### `get_frames` — Frames only

```
> Extract frames from this video with dense sampling
```

Two modes:
- **Scene-change detection** (default) — captures visual transitions
- **Dense sampling** (`dense: true`) — 1 frame/sec for full coverage

### `analyze_moment` — Deep-dive on a time range

```
> Analyze what happens between 1:30 and 2:00 in this video
```

Combines burst frame extraction + filtered transcript + OCR + annotated timeline for a focused segment. Use when you need to understand exactly what happens at a specific moment.

### `get_frame_at` — Single frame at a timestamp

```
> Show me the frame at 1:23 in this video
```

The AI reads the transcript, spots a critical moment, and requests the exact frame to see what's on screen.

### `get_frame_burst` — N frames in a time range

```
> Show me 10 frames between 0:15 and 0:17 of this video
```

For motion, vibration, animations, or fast scrolling — burst mode captures N frames in a narrow window so the AI can see frame-by-frame changes.

## Detail Levels

| Level | Frames | Transcript | OCR | Timeline | Use case |
|-------|--------|-----------|-----|----------|----------|
| `brief` | None | First 10 entries | No | No | Quick check — what's this video about? |
| `standard` | Up to 20 (scene-change) | Full | Yes | Yes | Default — full analysis |
| `detailed` | Up to 60 (1fps dense) | Full | Yes | Yes | Deep analysis — every second captured |

## Caching

Results are cached in memory for 10 minutes. Subsequent calls with the same URL and options return instantly. Use `forceRefresh: true` to bypass the cache.

## Supported Sources

| Source | Transcript | Metadata | Comments | Frames | Auth |
|--------|:----------:|:--------:|:--------:|:------:|:----:|
| **Loom** | Yes | Yes | Yes | Yes | None |
| **Direct URL** (.mp4, .mov, .mkv, .webm, …) | No | Duration only | No | Yes | None |
| **Direct URL + TwelveLabs** | Yes (Pegasus ASR) | Title only | No | Yes | `TWELVELABS_API_KEY` |
| **Local file** (absolute path or `file://` URI) | Sidecar `.vtt`/`.srt` or Whisper fallback | Probed via ffmpeg (duration, dims, codec, audio presence) | No | Yes | None |

> **Local files**: pass an absolute path (e.g., `/Users/you/clip.mp4`) or a `file://` URI as the `url` argument to any tool. Relative paths are rejected — the server's working directory is unpredictable from the MCP client. Note that any caller of the MCP server can ask it to read any file the server process has access to.
>
> **Sidecar transcripts**: if a `clip.vtt`, `clip.srt`, `clip.en.vtt`, etc. lives next to `clip.mp4`, it's used as the transcript automatically — no Whisper roundtrip needed. SRT is converted to VTT in-memory.
>
> **Embedded subtitles**: if no sidecar is found and the container has an embedded subtitle stream (common in `.mkv` / `.mov` / `.mp4` from screen recorders), it's transmuxed to VTT via ffmpeg and used as the transcript.
>
> **Recognized extensions** (local files and direct URLs): `.mp4` `.mov` `.mkv` `.webm` `.avi` `.m4v` `.wmv` `.flv` `.mpeg` `.mpg` `.m2ts` `.mts` `.3gp` `.ogv`. The extension only gates routing — ffmpeg does the actual demuxing, so most common containers work. `.ts` is excluded to avoid colliding with TypeScript source files.

### TwelveLabs Pegasus (optional)

Set the `TWELVELABS_API_KEY` environment variable to analyze direct video URLs with [TwelveLabs](https://twelvelabs.io) **Pegasus**. Pegasus analyzes the video server-side (visuals **and** its own audio ASR) and returns a timestamped transcript plus an AI summary as text — capabilities the `DirectAdapter` can't provide (a raw `.mp4` URL has no transcript or summary on its own), and with **no Whisper key required**.

The biggest win is on the text-only paths: `get_transcript` and `get_metadata` now return a real Pegasus transcript and summary for direct URLs — a few KB of text, no frame images, no per-frame token cost. `analyze_video` at `detail: "standard"`/`"detailed"` still extracts frames in addition (use `detail: "brief"` to stay text-only).

It's fully opt-in and non-breaking: when `TWELVELABS_API_KEY` is set the `TwelveLabsAdapter` handles direct video URLs (it registers the public URL with TwelveLabs — no upload); when it's unset, the `DirectAdapter` handles them exactly as before. Loom URLs are unaffected. Get a key at [playground.twelvelabs.io](https://playground.twelvelabs.io).

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
| **OCR** | Extracts text visible on screen from each frame (via tesseract.js) | Captures code, error messages, terminal output, UI text that the transcript doesn't cover |
| **Annotated timeline** | Merges transcript timestamps + frame timestamps + OCR text into a single chronological view | Gives the AI a unified "what was said, what changed visually, and what text appeared" at each moment |

The OCR step requires `tesseract.js` (included as a dependency). If it fails to load, analysis continues without OCR — no frames or transcript are lost.

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
