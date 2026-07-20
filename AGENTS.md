# AGENTS.md

Instructions for AI agents (Codex, Cursor, Copilot, Gemini CLI, …) using this project as a tool. For contributing to the codebase itself, see [CLAUDE.md](CLAUDE.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## Analyzing a video

Preferred: install the `video` skill and follow its contract — [skills/video/SKILL.md](skills/video/SKILL.md):

```bash
npx skills add guimatheus92/mcp-video-analyzer
```

Without the skill, the one-shot CLI works from any shell (Node 18+ only; ffmpeg is bundled):

```bash
npx -y mcp-video-analyzer@latest analyze "<video-url-or-path>"
```

stdout is a single JSON document (`metadata`, `transcript`, `ocrResults`, `timeline`, `warnings`, and `frames` as `{ time, filePath, mimeType }` → JPEG key frames on disk). Progress goes to stderr. Read the frame images for visual questions; answer with timestamps. `analyze --help` lists all flags.

## MCP alternative

If your agent supports MCP, register the stdio server instead — richer tool set (`analyze_video`, `analyze_moment`, `get_transcript`, `get_metadata`, `get_frames`, `get_frame_at`, `get_frame_burst`, `analyze_videos`) with frames returned inline:

```json
{ "command": "npx", "args": ["-y", "mcp-video-analyzer@latest"] }
```

## Notes

- Platform URLs (YouTube, Instagram, TikTok, …) need `yt-dlp` on PATH; direct `.mp4/.webm/.mov` URLs and local files don't. Loom transcript/metadata/comments don't either. Loom **frames** usually do — most Loom videos are separate DASH video+audio streams that only `yt-dlp` merges; a CDN fallback covers some without it.
- The `warnings` array carries actionable hints (yt-dlp install, cookies via `YTDLP_COOKIES_FROM_BROWSER`, Whisper backends) — relay them, don't treat them as errors.
- An empty transcript plus a "silent audio" warning means the video has no speech; that's content, not a failure.
