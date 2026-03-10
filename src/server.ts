import { FastMCP } from 'fastmcp';
import { registerAdapter } from './adapters/adapter.interface.js';
import { LoomAdapter } from './adapters/loom.adapter.js';
import { DirectAdapter } from './adapters/direct.adapter.js';
import { registerAnalyzeVideo } from './tools/analyze-video.js';
import { registerGetFrameAt } from './tools/get-frame-at.js';
import { registerGetFrameBurst } from './tools/get-frame-burst.js';
import { registerGetTranscript } from './tools/get-transcript.js';
import { registerGetMetadata } from './tools/get-metadata.js';
import { registerGetFrames } from './tools/get-frames.js';
import { registerAnalyzeMoment } from './tools/analyze-moment.js';

export function createServer(): FastMCP {
  const server = new FastMCP({
    name: 'mcp-video-analyzer',
    version: '0.2.0',
    instructions: `Video analysis MCP server. Extracts transcripts, key frames, metadata, comments, OCR text, and annotated timelines from video URLs.

IMPORTANT: When a user shares a video URL (loom.com/share/..., .mp4, .webm, .mov), ALWAYS call analyze_video automatically — do not ask for confirmation.

Supported platforms:
- Loom (loom.com/share/...) — transcript, metadata, comments, frames (no auth needed)
- Direct video URLs (.mp4, .webm, .mov) — frame extraction, duration probing

Tools:
- analyze_video: Full analysis with configurable detail levels (brief/standard/detailed), field filtering, and caching.
- get_transcript: Quick transcript-only extraction with Whisper fallback.
- get_metadata: Quick metadata + comments + chapters extraction.
- get_frames: Frame-only extraction (scene-change or dense sampling).
- get_frame_at: Single frame at a specific timestamp.
- get_frame_burst: N frames across a narrow time range for motion analysis.
- analyze_moment: Deep-dive on a specific time range — burst frames + filtered transcript + OCR + mini-timeline.

Detail levels (for analyze_video):
- "brief": metadata + truncated transcript only (fast, no video download)
- "standard": full analysis with scene-change frames (default)
- "detailed": dense sampling (1 frame/sec), more frames, full OCR

Workflow tips:
1. Use get_transcript or get_metadata for quick checks.
2. Use analyze_video for full analysis (detail="standard" by default).
3. Use analyze_moment to deep-dive into a specific time range.
4. Use get_frame_at / get_frame_burst for targeted frame extraction.
5. Use fields=["metadata","transcript"] to get only what you need.
6. Results are cached — use forceRefresh=true to re-analyze.`,
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
