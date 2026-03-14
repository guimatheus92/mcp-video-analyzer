import { FastMCP } from 'fastmcp';
import { registerAdapter } from './adapters/adapter.interface.js';
import { DirectAdapter } from './adapters/direct.adapter.js';
import { LoomAdapter } from './adapters/loom.adapter.js';
import { registerAnalyzeMoment } from './tools/analyze-moment.js';
import { registerAnalyzeVideo } from './tools/analyze-video.js';
import { registerGetFrameAt } from './tools/get-frame-at.js';
import { registerGetFrameBurst } from './tools/get-frame-burst.js';
import { registerGetFrames } from './tools/get-frames.js';
import { registerGetMetadata } from './tools/get-metadata.js';
import { registerGetTranscript } from './tools/get-transcript.js';

export function createServer(): FastMCP {
  const server = new FastMCP({
    name: 'mcp-video-analyzer',
    version: '0.2.4',
    instructions: `Video analysis MCP server. Extracts transcripts, key frames, metadata, comments, OCR text, and annotated timelines from video URLs.

AUTOMATIC BEHAVIOR — Do NOT wait for the user to ask:
- When the user shares a video URL → call analyze_video immediately (detail="standard").
- When discussing a specific moment in a video → call analyze_moment with the time range.
- When the user asks "what happens at X:XX" → call get_frame_at or analyze_moment.
- When the user asks to compare frames or see motion → call get_frame_burst.
- When the transcript alone would answer the question → call get_transcript (faster, no download).
- When only metadata is needed (title, duration, comments) → call get_metadata (no download).

The AI should ALWAYS call the appropriate tool automatically — never ask "would you like me to analyze this video?" Just do it.

Supported platforms:
- Loom (loom.com/share/...) — transcript, metadata, comments, frames (no auth needed)
- Direct video URLs (.mp4, .webm, .mov) — frame extraction, duration probing

Tools (choose the most efficient one for the task):
- analyze_video: Full analysis. Use by default when a video URL appears. Returns transcript + frames + metadata + OCR + timeline.
  - detail="brief" → fast, metadata + truncated transcript, no video download
  - detail="standard" → default, scene-change frames + full transcript + OCR
  - detail="detailed" → dense 1fps sampling, more frames, thorough OCR
  - fields=["metadata","transcript"] → return only specific fields
  - Cached for 10min — use forceRefresh=true to re-analyze.
- get_transcript: Transcript only. Faster than analyze_video when you only need what was said. Whisper fallback for videos without native transcripts.
- get_metadata: Metadata + comments + chapters. No video download needed.
- get_frames: Frames only (scene-change or dense=true for 1fps). Use when you need visuals without transcript.
- get_frame_at: Single frame at a timestamp. Use when the transcript reveals an interesting moment and you want to see it.
- get_frame_burst: N frames in a narrow time range. Use for motion, animations, fast UI changes.
- analyze_moment: Deep-dive on a time range. Combines burst frames + filtered transcript + OCR + mini-timeline. Use when the user asks about a specific part of the video.

Decision flow:
1. User shares a video URL → analyze_video (standard)
2. User asks about a specific timestamp → analyze_moment or get_frame_at
3. User asks "what did they say about X" → get_transcript (fast, no download)
4. User asks "how long is this video" → get_metadata (fast, no download)
5. User asks for more detail after initial analysis → analyze_video (detailed) or analyze_moment
6. User asks to see motion/animation → get_frame_burst`,
  });

  // Register adapters (order matters: more specific first)
  registerAdapter(new LoomAdapter());
  registerAdapter(new DirectAdapter());

  // Register tools
  registerAnalyzeVideo(server);
  registerGetFrameAt(server);
  registerGetFrameBurst(server);
  registerGetTranscript(server);
  registerGetMetadata(server);
  registerGetFrames(server);
  registerAnalyzeMoment(server);

  return server;
}
