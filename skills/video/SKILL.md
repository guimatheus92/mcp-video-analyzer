---
name: video
description: Analyze a video (Loom, YouTube, Vimeo, TikTok, Instagram, X/Twitter, Twitch, Dailymotion, Facebook, direct URL, or local file) — transcript, key frames, OCR text, metadata, annotated timeline — and answer questions about it with timestamps.
argument-hint: "<video-url-or-path> [question]"
allowed-tools: Bash, Read, mcp__video-analyzer
homepage: https://github.com/guimatheus92/mcp-video-analyzer
license: MIT
---

Analyze the given video and answer the user's question (or summarize it if no question was asked). Always cite timestamps (`M:SS`) in your answer.

## Route A — video-analyzer MCP tools available (preferred)

If the `video-analyzer` MCP server is connected in this session, call its tools directly — do not use the CLI:

- General question or no question → `analyze_video` (detail `"standard"`)
- "What happens at X:XX" / a specific moment → `analyze_moment` (time range) or `get_frame_at`
- Question answerable from speech alone → `get_transcript` (fast, no download)
- Title / duration / views / comments only → `get_metadata` (no download)
- Motion or fast UI changes → `get_frame_burst`

## Route B — no MCP server (any agent with a shell)

Run the one-shot CLI via Bash (first run downloads the npm package — slow is not broken; progress streams on stderr):

```bash
npx -y mcp-video-analyzer@latest analyze "<video-url-or-path>"
```

stdout is a single JSON document: `metadata`, `transcript` (timestamped entries), `ocrResults` (on-screen text), `timeline`, `warnings`, and `frames` — an array of `{ time, filePath, mimeType }` pointing to JPEG key frames on disk. Then:

1. Parse the JSON from stdout.
2. Read the `frames[].filePath` images (in parallel) when the question needs visuals.
3. Answer from transcript + OCR + frames, citing timestamps.

Useful flags: `--detail brief|standard|detailed` (brief = metadata + transcript only, no frame extraction — the fast/cheap path), `--fields metadata,transcript` (filters the emitted JSON only; frames are still computed at standard detail), `--max-frames <1-60>`, `--language <code>` (force transcription language), `--out <dir>` (where frames are copied), `--force-refresh`. Run `npx -y mcp-video-analyzer@latest analyze --help` for the full list.

## Prerequisites & degradation

- Node.js 18+ (required). `ffmpeg` is bundled — no install needed.
- Platform URLs (YouTube, Instagram, TikTok, …) require `yt-dlp` on PATH; direct `.mp4/.webm/.mov` URLs and local files work without it. Loom transcript, metadata, and comments need no `yt-dlp` either. Loom **frames** usually do — Loom serves most videos as separate DASH video+audio streams that only `yt-dlp` fetches and merges; a CDN fallback covers some videos without it.
- The tool never fails on partial results: the `warnings` array carries actionable hints (yt-dlp install, `YTDLP_COOKIES_FROM_BROWSER` for Instagram/age-restricted, missing Whisper backend). Relay relevant warnings to the user instead of treating them as errors.
- An empty transcript alongside a "silent audio" warning means the video genuinely has no speech (common for muted Reels/Stories) — that is content, not a failure.
