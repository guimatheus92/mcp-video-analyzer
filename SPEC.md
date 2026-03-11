# SPEC.md — mcp-video-analyzer

## Overview

MCP server for video analysis — extracts transcripts, key frames, metadata, OCR text, and annotated timelines from video URLs. Zero-setup: no API keys required, bundled ffmpeg, graceful degradation when optional tools are missing.

## Competitive Landscape

### Direct Competitors

| Server | Language | Platforms | Transcript | Frames | OCR | Timeline | API Key Required |
|--------|----------|-----------|:----------:|:------:|:---:|:--------:|:----------------:|
| **mcp-video-analyzer** (this) | TypeScript | Loom, Direct URL | Yes | Yes (scene + dense + burst) | Yes (Tesseract.js) | Yes | No |
| **mcpVideoParser** | Python | Local files | Yes | Yes (LLaVA via Ollama) | No | No | No (Ollama) |
| **video-research-mcp** | Python | YouTube (via Gemini) | Yes | Yes (Gemini) | No | No | Yes (Gemini) |
| **loom-local-mcp-server** | Unknown | Loom, Local | No | Yes (scene detection) | No | No | No |
| **loom-transcript-mcp** | Unknown | Loom | Yes | No | No | No | No |
| **mcp-video** (felores) | Node.js | YouTube, Vimeo, X, TikTok | Yes | No | No | No | No |
| **vidcap-mcp-server** | TypeScript | YouTube | Yes | Yes (timestamp) | No | No | Yes (VidCap) |

### FFmpeg Wrappers (editing, not analysis)

| Server | Focus |
|--------|-------|
| **ffmpeg-mcp-lite** | Format conversion, trimming, compression |
| **ffmpeg-mcp** (video-creator) | Clip, concat, play, extract frames |
| **video-audio-mcp** | Full editing: overlays, watermarks, transitions, silence removal |

### Key Differentiators

Features **unique to mcp-video-analyzer** (not found in any competitor):

1. **Loom + direct URL in one server** — no other covers both
2. **OCR on extracted frames** (Tesseract.js) — captures code, errors, UI text
3. **dHash frame deduplication** — removes redundant screencast frames
4. **Annotated timeline** — unified chronological view (transcript + frames + OCR)
5. **Detail levels** (brief/standard/detailed) — cost/depth tradeoff control
6. **In-memory caching** with TTL — instant repeated queries
7. **Three-tier frame extraction** — yt-dlp+ffmpeg → Loom CDN API → headless Chrome
8. **Black frame detection** — filters DRM-protected/blank frames automatically
9. **Zero API keys required** — fully self-contained

---

## v0.2 — Shipped Features

### Tools (7 total)

| Tool | Purpose | New in v0.2 |
|------|---------|:-----------:|
| `analyze_video` | Full analysis with detail levels, caching, field filtering | Enhanced |
| `get_transcript` | Transcript-only with Whisper fallback | New |
| `get_metadata` | Metadata + comments + chapters | New |
| `get_frames` | Frames-only (scene-change or dense sampling) | New |
| `analyze_moment` | Deep-dive on a time range (burst + transcript + OCR) | New |
| `get_frame_at` | Single frame at timestamp | v0.1 |
| `get_frame_burst` | N frames in a time range | v0.1 |

### New Capabilities

- **Detail levels**: `brief` (metadata only), `standard` (default), `detailed` (dense 1fps sampling)
- **Field filtering**: Return only requested fields (e.g., `["metadata", "transcript"]`)
- **In-memory caching**: 10-min TTL, 50-entry cap, `forceRefresh` bypass
- **Dense sampling**: 1 frame/sec via `ffmpeg -vf fps=1`, capped at maxFrames
- **Whisper fallback**: HuggingFace transformers → whisper CLI → OpenAI API → graceful empty
- **Black frame detection**: Filters DRM-protected/blank frames (mean brightness < 10)
- **Loom CDN direct download**: Bypasses yt-dlp when unavailable (3-tier: yt-dlp → CDN API → browser)

### Quality & Tooling (v0.2.1–v0.2.3)

- Smoke test: MCP server startup verification via JSON-RPC initialize handshake
- Pre-publish verification: `npm pack` → install in temp dir → verify startup
- Centralized test infrastructure: `test/helpers/`, `test/smoke/`, `test/e2e/`
- Automatic import sorting via `@trivago/prettier-plugin-sort-imports`
- ESLint extended to cover `test/` and `scripts/`
- 193 unit tests, 46 E2E tests, 1 smoke test

---

## Adapters

| Platform | Adapter | Transcript | Metadata | Comments | Chapters | Frames | Download |
|----------|---------|:----------:|:--------:|:--------:|:--------:|:------:|:--------:|
| **Loom** | `LoomAdapter` | VTT (GraphQL) | GraphQL | GraphQL | No | yt-dlp → CDN → browser | yt-dlp → CDN API |
| **Direct URL** | `DirectAdapter` | Whisper fallback | Duration (ffprobe) | No | No | yt-dlp → browser | HTTP fetch |

---

## Processing Pipeline

```
URL → Adapter (transcript, metadata, comments)
  → Download video (yt-dlp → CDN → browser)
    → Frame extraction (scene/dense/burst/single)
      → Black frame filtering
      → Image optimization (sharp: resize ≤800px, JPEG q=70)
      → Perceptual deduplication (dHash, Hamming ≤5)
      → OCR (Tesseract.js)
    → Audio extraction (ffmpeg → 16kHz mono WAV)
      → Whisper transcription (HF → CLI → OpenAI)
  → Annotated timeline (merge transcript + frames + OCR)
  → Field filter → Cache → Response
```

---

## Roadmap

### v0.3 — Platform Expansion

- **YouTube adapter** — yt-dlp for download, captions API for transcript, metadata scraping
- **Vimeo adapter** — oEmbed for metadata, yt-dlp for download
- **Batch analysis** — analyze multiple URLs in one call
- **Structured JSON output** — schema-validated response format

### v0.4 — AI-Powered Features

- **Video Q&A tool** — ask questions about a video, get answers grounded in transcript + frames
- **Video comparison** — compare two videos side-by-side (diff in content/visuals)
- **Auto-summary generation** — AI-generated summary from transcript + key frames
- **Moment detection** — automatically identify interesting moments (scene changes + speech patterns)

### v0.5 — Enterprise & Scale

- **Persistent cache** (SQLite) — survive server restarts
- **Webhook notifications** — async analysis with callback
- **Rate limiting** — per-URL and global limits
- **Authentication** — support for private/authenticated video URLs

---

## Registries

- **npm**: [mcp-video-analyzer](https://www.npmjs.com/package/mcp-video-analyzer)
- **Smithery.ai**: Listed via `smithery.yaml`
- **Glama.ai**: Pending submission
