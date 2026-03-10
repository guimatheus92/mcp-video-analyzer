# SPEC: Video Analyzer MCP Server

**Status:** v0.2 IN PROGRESS
**Created:** 2026-03-08
**License:** MIT (Open Source)
**Goal:** Build a generic video MCP that extracts transcripts + visual frames + metadata from any video platform (Loom, YouTube, direct URLs), so AI agents can fully understand video content.

---

## 1. Problem Statement

AI agents cannot watch videos. When someone records a bug report on Loom, a product demo on YouTube, or a vibration test as an mp4, the AI has zero context about what's in the video. You end up manually describing what's on screen — defeating the purpose of recording it in the first place.

We need an MCP server that extracts **everything useful** from a video — what was said, what was shown, what people commented — so the AI gets full context from a single URL.

**Why generic instead of Loom-only?**
- The hard work (ffmpeg frame extraction, MCP plumbing) is platform-agnostic
- Only ~20% extra effort to support multiple platforms via adapters
- Way more useful to the community (not everyone uses Loom)
- YouTube support alone would drive massive adoption
- MVP starts with Loom adapter, others follow naturally

---

## 1.1 Why This MCP Is Different

No existing video MCP combines all of these. Most do only one thing (transcript OR frames OR metadata). **`mcp-video-analyzer` does everything:**

| Capability | This MCP | karbassi/loom-mcp | Slaycaster/loom-local | jackculpan/authless | m2ai/loom-video |
|-----------|:--------:|:-----------------:|:---------------------:|:-------------------:|:---------------:|
| Key frames (scene-change) | Yes | - | Yes | - | - |
| Frame at specific timestamp | Yes | - | - | - | - |
| Burst frames (motion/vibration) | Yes | - | - | - | - |
| Transcript with timestamps | Yes | Yes | - | Yes | - |
| Speaker identification | Yes | Yes | - | - | - |
| Comments (timestamped) | Yes | Yes | - | Yes | - |
| Chapters / sections | Yes | Yes | - | - | - |
| AI-generated summary | Yes | Yes | - | - | - |
| Key takeaways | Yes | Yes | - | - | - |
| Video metadata | Yes | Yes | - | Yes | Yes |
| Multi-platform (Loom, YouTube, mp4) | Yes | Loom only | Loom only | Loom only | Loom only |
| No auth required (public videos) | Yes | Cookie needed | Yes | Yes | OAuth needed |
| One-command install (npx) | Yes | Python/uv | Docker | Cloudflare deploy | pip |
| Open source (MIT) | Yes | Yes | Yes | Yes | Yes |

**Unique features no other MCP has:**
1. **Frames + transcript + metadata in one tool** — no other MCP combines all three
2. **Frame at any timestamp** — AI reads transcript, spots the moment, requests the exact frame
3. **Burst frame mode** — captures motion/vibration that scene-change detection misses
4. **Multi-platform adapters** — not locked to one video provider
5. **Zero setup** — `npx mcp-video-analyzer` just works (ffmpeg bundled)

---

## 2. Existing Loom MCP Solutions Analysis

### 2.1 karbassi/loom-mcp (Python/uv)
- **Approach:** Uses Loom's internal GraphQL API (undocumented)
- **Auth:** Session cookie (`connect.sid`) — expires every ~30 days
- **Strengths:** 59 tools, transcripts with timestamps + speaker info, AI summaries, chapters, comments, search
- **Weaknesses:** No visual frame extraction, cookie-based auth is fragile
- **Takeaway:** Best for metadata and transcript extraction logic

### 2.2 Slaycaster/loom-local-mcp-server (Docker/Python)
- **Approach:** Downloads video, uses ffmpeg for scene-change detection
- **Auth:** None (downloads from public URL)
- **Strengths:** Key frame extraction with configurable sensitivity, scene-change detection
- **Weaknesses:** No transcripts, requires Docker, only 1 tool
- **Takeaway:** Best for visual frame extraction approach — ffmpeg scene detection is the right technique

### 2.3 jackculpan/loom-remote-mcp-server-authless (TypeScript/Cloudflare)
- **Approach:** Scrapes Loom's public page data (no auth needed)
- **Auth:** None
- **Strengths:** Zero auth, deploys to Cloudflare, transcripts + comments
- **Weaknesses:** No frames, depends on Loom's page structure (fragile)
- **Takeaway:** Proves that basic transcript extraction works without auth

### 2.4 m2ai-mcp-servers/mcp-loom-video (Python/pip)
- **Approach:** Uses Loom's official OAuth2 API
- **Auth:** OAuth2 access token via Loom Developer Portal
- **Strengths:** Official API, video editing (trim, merge)
- **Weaknesses:** No transcripts, no frames, Loom's public API may be limited
- **Takeaway:** Official API path exists but is limited

### 2.5 bStyler/loom-transcript-mcp (TypeScript)
- **Approach:** Fixed fork of transcript extraction via GraphQL
- **Auth:** Cookie
- **Strengths:** Fixed 400 errors from API changes
- **Weaknesses:** Only transcripts
- **Takeaway:** GraphQL API changes over time — need resilient error handling

---

## 3. Reference MCP Servers (Gold Standards)

Before building, we studied the top MCP servers on GitHub to learn patterns:

### 3.1 @playwright/mcp (28k+ stars) — Microsoft
- **Stack:** TypeScript, published to npm
- **Install:** `npx @playwright/mcp@latest` or `claude mcp add playwright npx @playwright/mcp@latest`
- **Pattern:** Single npm package, `bin` field in package.json, shebang in entry point
- **Structure:** `packages/` monorepo, clean separation of tools
- **Takeaway:** The gold standard for "install in one command" DX

### 3.2 github-mcp-server (27k+ stars) — GitHub Official
- **Stack:** Go (but we'll use TypeScript)
- **Pattern:** Official vendor MCP, comprehensive tool set for one domain
- **Takeaway:** Proves single-domain focus with many tools works well

### 3.3 modelcontextprotocol/servers (Official Reference) — Anthropic
- **Stack:** TypeScript, published to npm as `@modelcontextprotocol/server-*`
- **Servers:** filesystem, fetch, git, memory, sequential-thinking, time
- **Pattern:** Each server is a focused, single-purpose tool set
- **Takeaway:** Official patterns for tool schemas, error handling, stdio transport

### 3.4 FastMCP Framework (TypeScript)
- **Stack:** TypeScript framework wrapping the official SDK
- **Pattern:** Zod schemas for tool params, `server.addTool()` API, built-in auth/streaming
- **Supports:** stdio, HTTP streaming, SSE, Cloudflare Workers (EdgeFastMCP)
- **Takeaway:** Use FastMCP for faster development with less boilerplate

### 3.5 context7 (48k+ stars) — Upstash
- **Stack:** TypeScript, published to npm
- **Pattern:** Up-to-date docs for LLMs, single clear purpose
- **Takeaway:** Massive adoption proves the "one tool, does it well" approach

### Key Patterns from Top Repos

| Pattern | Details |
|---------|---------|
| **Distribution** | npm package with `bin` field → users run `npx @scope/package@latest` |
| **Install UX** | `claude mcp add <name> npx @scope/package@latest` — one command |
| **Stdio first** | All top MCPs default to stdio transport for local use |
| **Zod schemas** | Tool input validation via Zod (or JSON Schema) |
| **Single domain** | One MCP = one domain (browser, github, filesystem...) |
| **Progress** | Long operations send progress notifications |

---

## 4. Proposed Architecture

### 4.1 Complete Feature Map

Everything the MCP extracts from a video, organized by data type:

| Category | Feature | Source | Version |
|----------|---------|--------|---------|
| **Visual** | Key frames (scene-change detection) | ffmpeg | v0.1 |
| **Visual** | Frame at specific timestamp | ffmpeg | v0.1 |
| **Visual** | Burst frames (N frames in a time range — motion/vibration) | ffmpeg | v0.1 |
| **Visual** | Dense sampling (1 frame/sec for "watching") | ffmpeg | v0.2 |
| **Audio** | Transcript with timestamps | Platform API / page scrape | v0.1 |
| **Audio** | Speaker identification | Platform API (if available) | v0.1 |
| **Audio** | Whisper fallback transcription | Whisper API / whisper.cpp | v0.2 |
| **Metadata** | Title, description, duration | Platform API / page scrape | v0.1 |
| **Metadata** | Chapters / sections | Platform API | v0.1 |
| **Social** | Comments (timestamped) | Platform API | v0.1 |
| **Social** | Reactions | Platform API | v0.3 |
| **AI** | AI-generated summary | Platform API (Loom has this) | v0.1 |
| **AI** | Key takeaways | Platform API (Loom has this) | v0.1 |
| **Search** | Search video library | Platform API (requires auth) | v0.3 |

### 4.2 Tool Design (7 tools)

```
Tools (v0.1):
├── analyze_video(url, options?)           → Full analysis with detail levels, caching, field filtering
├── get_frame_at(url, timestamp)           → Single frame at a specific timestamp
└── get_frame_burst(url, from, to, count?) → N frames in a time range (motion/vibration)

Tools (v0.2):
├── get_transcript(url)                    → Transcript-only with Whisper fallback
├── get_metadata(url)                      → Metadata + comments + chapters + AI summary
├── get_frames(url, options?)              → Frames-only (scene-change or dense sampling)
└── analyze_moment(url, from, to, count?)  → Deep-dive: burst frames + filtered transcript + OCR + timeline

Tools (v0.3):
└── search_videos(query)                   → Search your video library (platform-specific, requires auth)
```

**Primary tool:** `analyze_video` — one call, full context. The others exist for when you only need partial data.

**`get_frame_at`** is specifically useful for debugging: the AI reads the transcript, identifies a critical moment, and requests the exact frame at that timestamp to see what's on screen.

### 4.3 Frame Extraction Modes

Three modes for different use cases:

**Mode 1: Scene-change detection (default for `analyze_video`)**

ffmpeg automatically determines how many frames to extract based on visual changes:

| Video type | Typical frames | Why |
|-----------|---------------|-----|
| Static screen + 3 clicks | ~5 frames | Few visual changes |
| Fast UI demo with navigation | ~15-25 frames | Many page transitions |
| Talking head only | ~2-3 frames | Almost no visual change |
| Code walkthrough with scrolling | ~10-15 frames | Moderate changes |

Parameters:
- `threshold` (0.0-1.0, default 0.3) — sensitivity. Lower = more frames captured
- `max_frames` (default 20) — safety cap to prevent context window bloat

**Mode 2: Burst frames (`get_frame_burst`)**

Captures N frames evenly distributed in a time range. Designed for motion and vibration analysis where scene-change detection fails because the "scene" doesn't change — only the position/state of objects does.

Example: `get_frame_burst(url, from="0:15", to="0:17", count=10)` → 10 frames in 2 seconds
- AI sees the object in different positions across frames → understands the vibration
- Works for: shaking, flickering, animations, fast scrolling, loading spinners

**Mode 3: Dense sampling (v0.2)**

1 frame per second across the entire video. Useful for "watching" the full video when scene-change might miss gradual changes.

### 4.4 Adapter Architecture (Generic Platform Support)

```
src/
├── index.ts                    # Entry point (shebang + MCP server setup)
├── server.ts                   # FastMCP server definition + tool registration
├── tools/                      # MCP tool definitions
│   ├── analyze-video.ts
│   ├── get-transcript.ts
│   ├── get-frames.ts
│   ├── get-frame-at.ts
│   ├── get-metadata.ts
│   └── search-videos.ts
├── adapters/                   # Platform-specific logic
│   ├── adapter.interface.ts    # IVideoAdapter interface
│   ├── loom.adapter.ts         # Loom: page scrape + GraphQL
│   ├── youtube.adapter.ts      # YouTube: yt-dlp + captions API
│   └── direct.adapter.ts       # Direct URL: any mp4/webm link
├── processors/                 # Shared processing (platform-agnostic)
│   ├── frame-extractor.ts      # ffmpeg scene detection + timestamp extraction
│   ├── image-optimizer.ts      # Resize, compress frames
│   └── transcript-fallback.ts  # Whisper fallback when no native transcript
├── utils/
│   ├── url-detector.ts         # Detect platform from URL (loom.com → loom adapter)
│   ├── cache.ts                # In-memory cache with TTL
│   └── temp-files.ts           # Temp directory management
└── types.ts                    # Shared TypeScript interfaces
```

### 4.5 Adapter Interface

```typescript
interface IVideoAdapter {
  /** Check if this adapter handles the given URL */
  canHandle(url: string): boolean;

  /** Download the video file to a temp path */
  downloadVideo(url: string): Promise<string>;

  /** Get native transcript (if platform provides one) */
  getTranscript(url: string): Promise<ITranscriptEntry[] | null>;

  /** Get video metadata */
  getMetadata(url: string): Promise<IVideoMetadata>;
}
```

**URL auto-detection flow:**
```
URL received
  │
  ├─ loom.com/*        → LoomAdapter
  ├─ youtube.com/*     → YouTubeAdapter
  ├─ youtu.be/*        → YouTubeAdapter
  ├─ *.mp4 / *.webm    → DirectAdapter
  └─ unknown           → Error: "Unsupported video platform"
```

### 4.6 Data Flow

```
Any Video URL
  │
  ├─► URL Detection → Select Adapter
  │
  ├─► adapter.getMetadata(url)
  │     → title, description, duration, comments, chapters
  │
  ├─► adapter.getTranscript(url)
  │     → timestamped text (or null → Whisper fallback)
  │
  └─► adapter.downloadVideo(url) → ffmpeg processing
        ├─► Scene-change detection → key frames (images)
        ├─► Single frame at timestamp → get_frame_at
        └─► Audio extraction → Whisper transcription (fallback)
```

### 4.7 Output to Claude

```json
{
  "platform": "loom",
  "title": "Bug: Cart total not updating",
  "duration": "2:34",
  "transcript": [
    { "time": "0:05", "speaker": "Guilherme", "text": "So when I click add to cart..." },
    { "time": "0:12", "speaker": "Guilherme", "text": "The total stays at zero..." }
  ],
  "key_frames": [
    { "time": "0:05", "image": "<base64 or file path>", "description": "Homepage with cart icon" },
    { "time": "0:12", "image": "<base64 or file path>", "description": "Cart showing $0.00 total" }
  ],
  "comments": [
    { "author": "John", "time": "0:12", "text": "This also happens on mobile" }
  ],
  "chapters": [...],
  "ai_summary": "User demonstrates a bug where..."
}
```

---

## 5. Technical Decisions

### 5.1 Language/Stack — TypeScript + FastMCP

| Option | Pros | Cons |
|--------|------|------|
| **TypeScript (Node.js)** | Official MCP SDK, ecosystem maturity, we already know it, most MCP examples | Slower than Go for video processing (but ffmpeg does the heavy lifting) |
| **Python** | Good ffmpeg/whisper libs, most existing Loom MCPs use it | We don't use Python in our stack |
| **Go** | Fast binary, low memory, great for CLI tools | No official MCP SDK, fewer examples |
| **Ruby** | N/A | No MCP ecosystem, no benefit |

**Decision: TypeScript with FastMCP**
- FastMCP = less boilerplate, Zod validation, built-in streaming support
- Official MCP SDK underneath (FastMCP wraps it)
- We're a TypeScript shop — easier to maintain
- Video processing is done by ffmpeg (native binary) anyway, so language performance doesn't matter

### 5.2 Transport

- **Stdio** for local use (Claude Code, VS Code) — no network overhead
- Optionally add Streamable HTTP later if we want remote deployment

### 5.3 Video Processing

- **ffmpeg** for frame extraction (scene-change detection filter: `select='gt(scene,THRESHOLD)'`)
- **ffmpeg** for single frame at timestamp: `ffmpeg -ss TIMESTAMP -i video -frames:v 1`
- **ffmpeg** for audio extraction
- **Whisper** (local via whisper.cpp or API) as fallback transcription when no native transcript

### 5.4 Authentication Strategy

Per-adapter, configured via env vars:
- **Loom:** No auth for public videos (page scrape), optional `LOOM_COOKIE` for private videos + GraphQL
- **YouTube:** No auth for public videos, optional `YOUTUBE_API_KEY` for private/metadata
- **Direct:** No auth needed

### 5.5 Dependencies

```
fastmcp                        # MCP framework (wraps @modelcontextprotocol/sdk)
zod                            # Schema validation
ffmpeg-static                  # Bundled ffmpeg binary (zero setup for users)
fluent-ffmpeg                  # Node.js ffmpeg wrapper
sharp                          # Image optimization (resize frames)
cheerio                        # HTML parsing for page scraping
```

### 5.6 Frame Delivery

Options for sending frames to Claude:
- **Base64 inline** — simplest, works everywhere, but large payloads
- **File paths** — save to temp dir, return paths (Claude Code can read images)
- **Optimized thumbnails** — resize to ~800px width, JPEG quality 70% before encoding

**Decision:** Save to temp dir + return file paths. Claude Code reads images natively. Add option for base64 for remote/HTTP transport.

---

## 6. Distribution & Publishing

### 6.1 How Users Install It

**One-command install for Claude Code:**
```bash
claude mcp add video-analyzer npx mcp-video-analyzer@latest
```

**Manual config (Claude Desktop, Cursor, VS Code, etc.):**
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

**With optional env vars (for authenticated features):**
```json
{
  "mcpServers": {
    "video-analyzer": {
      "command": "npx",
      "args": ["mcp-video-analyzer@latest"],
      "env": {
        "LOOM_COOKIE": "connect.sid=abc123...",
        "YOUTUBE_API_KEY": "AIza..."
      }
    }
  }
}
```

### 6.2 npm Package Setup

Following the Playwright MCP pattern:

```json
{
  "name": "mcp-video-analyzer",
  "version": "0.1.0",
  "description": "MCP server for video analysis — transcripts, key frames, and metadata. Supports Loom, YouTube, and direct URLs.",
  "bin": {
    "mcp-video-analyzer": "./dist/index.js"
  },
  "files": ["dist"],
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "npx fastmcp dev src/index.ts",
    "inspect": "npx fastmcp inspect src/index.ts",
    "prepublishOnly": "npm run build"
  },
  "keywords": ["mcp", "video", "loom", "youtube", "transcript", "frames", "claude", "ai"],
  "license": "MIT"
}
```

Entry point (`src/index.ts`) must start with:
```typescript
#!/usr/bin/env node
```

### 6.3 Publishing

```bash
npm login
npm run build
npm publish --access public
```

Users get the latest version automatically via `npx mcp-video-analyzer@latest`.

### 6.4 Listing on MCP Registries

Submit to these directories for discoverability:
- [Smithery.ai](https://smithery.ai) — largest MCP registry
- [awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) — curated GitHub list
- [PulseMCP](https://www.pulsemcp.com) — MCP server directory

---

## 7. Development Workflow & Skills

### 7.1 Anthropic's mcp-builder Skill

We follow the official [mcp-builder skill](https://github.com/anthropics/skills/blob/main/skills/mcp-builder/SKILL.md) from Anthropic — a structured 4-phase workflow for building MCP servers:

| Phase | What | Details |
|-------|------|---------|
| **1. Deep Research** | Study MCP protocol, framework docs, plan implementation | Read reference docs: `node_mcp_server.md`, `mcp_best_practices.md` |
| **2. Implementation** | Project structure, core infra, tool definitions | Zod schemas, FastMCP `server.addTool()`, adapter pattern |
| **3. Review & Test** | Code quality, MCP Inspector testing | `npx fastmcp inspect src/index.ts` |
| **4. Evaluations** | 10 evaluation questions to verify correctness | XML format per `evaluation.md` |

The skill is saved locally at `.claude/skills/mcp-builder.md` for Claude to reference during development.

### 7.2 skilld — Auto-Generated Dependency Skills

After `npm install`, run:
```bash
npx skilld
```

This scans `node_modules` and generates a `SKILL.md` with API signatures and usage patterns for each dependency (fastmcp, zod, sharp, fluent-ffmpeg, etc.), giving Claude accurate context without searching docs.

**When to run:** After initial `npm install` and after adding new dependencies.

---

## 8. MCP Best Practices (from official docs + top repos)

Based on [MCP Architecture](https://modelcontextprotocol.io/docs/learn/architecture), [best practices 2026](https://www.cdata.com/blog/mcp-server-best-practices-2026), and patterns from Playwright/GitHub/Context7 MCPs:

- **Single domain focus** — video analysis (don't try to be everything)
- **Zod schemas** for all tool inputs — type-safe, auto-generates JSON Schema
- **Structured errors** with actionable messages and error codes
- **Caching** for repeated requests (same video URL → cached results)
- **Progress notifications** for long operations (video download + ffmpeg processing)
- **Stdio transport first** — zero config, works everywhere
- **npx distribution** — one command to install, always latest version
- **Minimal dependencies** — keep the package small and fast to install

---

## 9. MVP Scope

### v0.1 — Loom + Core ✅ SHIPPED
- [x] `analyze_video(url)` — full analysis: transcript + key frames + metadata + comments + chapters + AI summary
- [x] `get_frame_at(url, timestamp)` — single frame at a specific timestamp
- [x] `get_frame_burst(url, from, to, count?)` — N frames in a time range (motion/vibration)
- [x] Adapter architecture with URL auto-detection
- [x] Loom adapter: page scrape for transcript, comments, chapters, AI summary, video download (no auth)
- [x] Direct URL adapter: any mp4/webm link
- [x] ffmpeg scene-change frame extraction + single-frame + burst
- [x] Frame optimization (resize, compress via sharp) + deduplication
- [x] OCR text extraction from frames (tesseract.js)
- [x] Annotated timeline merging transcript + frames + OCR
- [x] Browser-based frame extraction fallback (puppeteer-core)
- [x] Return frames as file paths (base64 option)
- [x] Stdio transport, published to npm, one-command install

### v0.2 — Detail Levels, New Tools, Caching 🚧 IN PROGRESS
- [x] `get_transcript(url)` — transcript-only with Whisper fallback
- [x] `get_metadata(url)` — metadata + comments + chapters
- [x] `get_frames(url, options?)` — frames-only (scene-change or dense sampling)
- [x] `analyze_moment(url, from, to, count?)` — deep-dive on a specific time range
- [x] Configurable detail levels: brief / standard / detailed
- [x] Field filtering: `fields=["metadata", "transcript"]` returns only requested data
- [x] In-memory caching with TTL (10min default, 50 entries max, LRU eviction)
- [x] `forceRefresh` option to bypass cache
- [x] Dense sampling mode (1 frame/sec) for detailed analysis
- [x] Whisper fallback transcription: @huggingface/transformers → whisper CLI → OpenAI API → graceful empty
- [x] Audio extraction from video (ffmpeg → WAV)
- [ ] E2E tests for all new tools
- [ ] Updated README with new features

### v0.3 — Auth + Polish + Paid APIs
- [ ] `search_videos(query)` (Loom, requires auth)
- [ ] Loom GraphQL API support with cookie auth
- [ ] Gemini native video processing (optional, paid)
- [ ] Streamable HTTP transport (for remote deployment)
- [ ] Reactions extraction from platform APIs

### v0.4 — YouTube Adapter
- [ ] YouTube adapter (yt-dlp + YouTube captions API)
- [ ] YouTube URL detection (youtube.com, youtu.be)
- [ ] YouTube transcript extraction (auto-captions, manual captions)
- [ ] YouTube metadata (title, description, duration, channel)

### v0.5 — Advanced Features
- [ ] Structured output schemas (JSON Schema for response format)
- [ ] Batch video analysis (multiple URLs in one call)
- [ ] Video Q&A tool (ask questions about a video)
- [ ] Moment comparison (compare two time ranges side-by-side)

---

## 10. Resolved Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| Open source? | **Yes, MIT** | No existing MCP does transcript + frames. Community benefit is huge. |
| Language? | **TypeScript** | Official MCP SDK, our stack, ffmpeg does heavy lifting anyway |
| Framework? | **FastMCP** | Less boilerplate, Zod built-in, good enough for this scope |
| Generic or Loom-only? | **Generic with adapters** | ~20% more work, 10x more useful. MVP starts with Loom. |
| ffmpeg bundled or global? | **`ffmpeg-static` (bundled)** | Zero setup for users. Playwright bundles Chromium (~200MB), 70MB for ffmpeg is fine. DX > package size. |
| Frame delivery? | **File paths** | Claude Code reads images natively. Base64 option for remote. |
| Package name? | **`mcp-video-analyzer`** | Available on npm. Self-explanatory. Easy to find when searching "mcp video". |
| GitHub repo? | **Personal org, new repo** | `github.com/<user>/mcp-video-analyzer` |
| npm scope? | **Unscoped** | `mcp-video-analyzer` (not tied to any company) |

---

## 11. Open Questions

1. **Frame count trade-off:** How many frames is optimal? 10? 20? Too many = context window bloat. Need to test.
2. **Whisper integration:** Use OpenAI Whisper API, integrate whisper.cpp directly, or skip for MVP?
3. **yt-dlp dependency (v0.2):** YouTube adapter needs yt-dlp for video download. Bundle it or require global install?

---

## 12. Competitive Research (Glama.ai, March 2026)

### 12.1 Video/Media MCPs on Glama.ai

| MCP | Key Feature We Don't Have | Status |
|-----|--------------------------|--------|
| **mcpVideoParser** | Ollama/Llava local vision, moment analysis, video Q&A | v0.2 adds moment analysis; Q&A deferred to v0.5 |
| **video-research-mcp** | Gemini native video, structured output, batch analysis | Gemini deferred to v0.3; batch to v0.5 |
| **yt-dlp-mcp** | YouTube download via yt-dlp | YouTube adapter deferred to v0.4 |
| **fast-whisper-mcp-server** | Fast Whisper transcription (Python) | v0.2 adds Whisper fallback (JS-native) |
| **ffmpeg-mcp-lite** | Dense sampling (1fps), video editing | v0.2 adds dense sampling |
| **sinco-lab/mcp-youtube-transcript** | YouTube transcript extraction | Deferred to v0.4 |
| **mcp-tiktok** | TikTok video analysis | Out of scope (different platform category) |

### 12.2 Features Adopted in v0.2

From competitive analysis, we adopted:
1. **Detail levels** (inspired by mcpVideoParser's analysis depth options)
2. **Moment analysis** (inspired by mcpVideoParser's time-range deep-dive)
3. **Dense sampling** (inspired by ffmpeg-mcp-lite's 1fps approach)
4. **Whisper fallback** (inspired by fast-whisper-mcp-server, but JS-native for zero-setup)
5. **Caching** (inspired by video-research-mcp's session caching)
6. **Field filtering** (inspired by video-research-mcp's structured output — simpler version)

### 12.3 Registry Listings

| Registry | Status |
|----------|--------|
| [npm](https://www.npmjs.com/package/mcp-video-analyzer) | Published ✅ |
| [Glama.ai](https://glama.ai/mcp/servers/guimatheus92/mcp-video-analyzer) | Approved ✅ |
| [Smithery.ai](https://smithery.ai) | PR submitted 🔄 |
| [awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) | PR #2982 submitted 🔄 |
| [PulseMCP](https://www.pulsemcp.com) | Not yet submitted |

---

## 13. References

### Existing Loom MCPs (studied for approach)
- [karbassi/loom-mcp](https://github.com/karbassi/loom-mcp) — Python, GraphQL API, 59 tools, best metadata
- [Slaycaster/loom-local-mcp-server](https://github.com/Slaycaster/loom-local-mcp-server) — Docker/Python, ffmpeg frame extraction
- [jackculpan/loom-remote-mcp-server-authless](https://github.com/jackculpan/loom-remote-mcp-server-authless) — TypeScript, no auth, Cloudflare
- [m2ai-mcp-servers/mcp-loom-video](https://github.com/m2ai-mcp-servers/mcp-loom-video) — Python, official OAuth2 API
- [bStyler/loom-transcript-mcp](https://github.com/bStyler/loom-transcript-mcp) — TypeScript, fixed GraphQL fork

### Reference MCP Servers (studied for architecture/patterns)
- [@playwright/mcp](https://github.com/microsoft/playwright-mcp) — 28k stars, gold standard npm distribution
- [github-mcp-server](https://github.com/github/github-mcp-server) — 27k stars, official vendor MCP
- [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) — Official reference implementations
- [FastMCP](https://github.com/punkpeye/fastmcp) — TypeScript MCP framework, Zod schemas
- [context7](https://github.com/nicepkg/context7) — 48k stars, single-purpose MCP

### MCP Protocol & Best Practices
- [MCP Official Architecture](https://modelcontextprotocol.io/docs/learn/architecture)
- [MCP Best Practices 2026](https://www.cdata.com/blog/mcp-server-best-practices-2026)
- [15 Best Practices for MCP Servers](https://thenewstack.io/15-best-practices-for-building-mcp-servers-in-production/)
- [Publishing MCP to npm](https://www.aihero.dev/publish-your-mcp-server-to-npm)

### Development Skills & Tools
- [Anthropic mcp-builder skill](https://github.com/anthropics/skills/blob/main/skills/mcp-builder/SKILL.md) — Official 4-phase MCP server build workflow (Research → Implement → Review → Evaluate)
- [skilld](https://github.com/harlan-zw/skilld) — Auto-generates SKILL.md from npm dependencies for Claude context

### Loom API
- [Loom Developer Docs](https://dev.loom.com/docs/record-sdk/details/api)
- ~~[Loom Agents MCP Docs](https://loom-agents.github.io/docs/agents/mcp/)~~ — Not useful (generic MCP client library, not Loom-specific)
