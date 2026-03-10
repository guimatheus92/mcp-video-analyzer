# Examples

Real outputs from running mcp-video-analyzer tools against a public Loom demo video.

**Source video:** [Boost In-App Demo Video](https://www.loom.com/share/bdebdfe44b294225ac718bad241a94fe) (2:55, by Josh Owens)

## Outputs

### JSON results

| File | Tool | Description |
|------|------|-------------|
| `loom-demo/metadata.json` | `get_metadata` | Title, duration, platform |
| `loom-demo/transcript.json` | `get_transcript` | 42 entries with timestamps and speaker identification |
| `loom-demo/comments.json` | `get_metadata` | Comments (empty for this video) |
| `loom-demo/chapters.json` | `get_metadata` | Chapters (empty for this video) |
| `loom-demo/ai-summary.json` | `get_metadata` | AI summary (null for this video) |
| `loom-demo/frames-scene.json` | `get_frames` | Scene-change frame metadata (standard detail) |
| `loom-demo/frames-dense-summary.json` | `get_frames` | Dense sampling summary (detailed level, 1fps) |
| `loom-demo/frames-burst.json` | `analyze_moment` | Burst frames for 0:30–0:45 range |
| `loom-demo/moment-transcript-0m30s-0m45s.json` | `analyze_moment` | Transcript segment for 0:30–0:45 |
| `loom-demo/timeline.json` | `analyze_video` | Annotated timeline (frames + transcript merged) |
| `loom-demo/ocr-results.json` | `analyze_video` | OCR results (skipped in generator) |
| `loom-demo/full-analysis.json` | `analyze_video` | Complete analysis result |

### Frame images

| Prefix | Count | Source | Description |
|--------|-------|--------|-------------|
| `scene_*.jpg` | 3 | Scene detection | Key visual transitions (threshold=0.05) |
| `dense_*.jpg` | 6 | Dense sampling | Every 10th frame from 1fps extraction (6 of 60 total) |
| `burst_*.jpg` | 10 | Moment analysis | 10 frames from the 0:30–0:45 time range |

## Regenerate

```bash
npx tsx examples/generate.ts
```

Requires: yt-dlp, ffmpeg (bundled via ffmpeg-static), network access.
