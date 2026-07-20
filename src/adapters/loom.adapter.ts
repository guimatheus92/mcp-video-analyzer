import { createWriteStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
  IAdapterCapabilities,
  IChapter,
  ITranscriptEntry,
  IVideoComment,
  IVideoMetadata,
} from '../types.js';
import { detectPlatform, extractLoomId } from '../utils/url-detector.js';
import { parseVtt } from '../utils/vtt-parser.js';
import type { IVideoAdapter } from './adapter.interface.js';
import { YtDlpAdapter } from './ytdlp.adapter.js';

const LOOM_GRAPHQL_URL = 'https://www.loom.com/graphql';

const GRAPHQL_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'User-Agent': 'mcp-video-analyzer/0.1.0',
};

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function loomGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T | null> {
  const response = await fetch(LOOM_GRAPHQL_URL, {
    method: 'POST',
    headers: GRAPHQL_HEADERS,
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    return null;
  }

  const json = (await response.json()) as GraphQLResponse<T>;

  if (json.errors?.length) {
    return null;
  }

  return json.data ?? null;
}

interface LoomVideoData {
  getVideo: {
    __typename: string;
    id: string;
    name: string;
    description?: string;
    playable_duration?: number;
    owner?: { display_name: string };
    createdAt?: string;
  };
}

interface LoomTranscriptData {
  fetchVideoTranscript: {
    captions_source_url?: string;
    source_url?: string;
    transcription_status?: string;
    language?: string;
  };
}

interface LoomComment {
  id: string;
  plain_content: string;
  time_stamp: number | null;
  user_name?: string;
  createdAt?: string;
  children_comments?: LoomComment[];
}

interface LoomCommentsData {
  getVideo: {
    comments: LoomComment[];
  };
}

function formatDuration(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function timestampFromMs(ms: number): string {
  return formatDuration(ms / 1000);
}

export class LoomAdapter implements IVideoAdapter {
  readonly name = 'loom';
  /** yt-dlp handles Loom natively; reuse the one correct download implementation. */
  private readonly ytdlp = new YtDlpAdapter();
  readonly capabilities: IAdapterCapabilities = {
    transcript: true,
    metadata: true,
    comments: true,
    chapters: false,
    aiSummary: false,
    videoDownload: true,
  };

  canHandle(url: string): boolean {
    return detectPlatform(url) === 'loom';
  }

  async getMetadata(url: string): Promise<IVideoMetadata> {
    const videoId = extractLoomId(url);

    const data = await loomGraphQL<LoomVideoData>(
      `query GetVideo($videoId: ID!, $password: String) {
        getVideo(id: $videoId, password: $password) {
          ... on RegularUserVideo {
            __typename id name description playable_duration
            owner { display_name }
            createdAt
          }
          ... on PrivateVideo {
            __typename id
          }
        }
      }`,
      { videoId, password: null },
    );

    const video = data?.getVideo;

    return {
      platform: 'loom',
      title: video?.name ?? 'Untitled Loom Video',
      description: video?.description ?? undefined,
      duration: video?.playable_duration ?? 0,
      durationFormatted: formatDuration(video?.playable_duration ?? 0),
      url,
    };
  }

  async getTranscript(url: string): Promise<ITranscriptEntry[]> {
    const videoId = extractLoomId(url);

    const data = await loomGraphQL<LoomTranscriptData>(
      `query FetchVideoTranscript($videoId: ID!, $password: String) {
        fetchVideoTranscript(videoId: $videoId, password: $password) {
          ... on VideoTranscriptDetails {
            captions_source_url
            source_url
            transcription_status
            language
          }
        }
      }`,
      { videoId, password: null },
    );

    const captionsUrl = data?.fetchVideoTranscript?.captions_source_url;
    if (!captionsUrl) {
      return [];
    }

    const vttResponse = await fetch(captionsUrl);
    if (!vttResponse.ok) {
      return [];
    }

    const vttContent = await vttResponse.text();
    return parseVtt(vttContent);
  }

  async getComments(url: string): Promise<IVideoComment[]> {
    const videoId = extractLoomId(url);

    const data = await loomGraphQL<LoomCommentsData>(
      `query FetchVideoComments($videoId: ID!, $password: String) {
        getVideo(id: $videoId, password: $password) {
          ... on RegularUserVideo {
            comments {
              id plain_content time_stamp user_name createdAt
              children_comments {
                id plain_content time_stamp user_name createdAt
              }
            }
          }
        }
      }`,
      { videoId, password: null },
    );

    const comments = data?.getVideo?.comments ?? [];
    return flattenComments(comments);
  }

  async getChapters(_url: string): Promise<IChapter[]> {
    return [];
  }

  async getAiSummary(_url: string): Promise<string | null> {
    return null;
  }

  /**
   * Never rejects — the pipeline calls this without a catch.
   *
   * Strategy 1 delegates to YtDlpAdapter instead of re-implementing the yt-dlp
   * call: this adapter used to pass `-o <id>.mp4`, but yt-dlp appends the real
   * container when it merges DASH streams, so it wrote `<id>.mp4.webm` and the
   * `.mp4` existence check silently discarded a perfectly good download
   * (issue #24). One implementation means that can't drift apart again.
   */
  async downloadVideo(
    url: string,
    destDir: string,
    onWarning?: (message: string) => void,
  ): Promise<string | null> {
    const reasons: string[] = [];

    // Strategy 1: yt-dlp (best quality, merges DASH video+audio-only Looms).
    const viaYtDlp = await this.ytdlp
      .downloadVideo(url, destDir, (m) => reasons.push(m))
      .catch((e: unknown) => {
        reasons.push(e instanceof Error ? e.message : String(e));
        return null;
      });
    if (viaYtDlp) return viaYtDlp;

    // Strategy 2: direct HTTP download via Loom CDN URL.
    const videoId = extractLoomId(url);
    const videoUrl = videoId ? await this.fetchVideoUrl(videoId).catch(() => null) : null;
    if (!videoUrl) {
      // Also covers transcoded-url answering 204 (OK, but no body to parse).
      reasons.push('Loom exposed no downloadable CDN URL for this video');
    } else {
      const outputPath = join(destDir, `${videoId ?? 'loom_video'}.mp4`);
      try {
        const response = await fetch(videoUrl);
        if (!response.ok || !response.body) {
          reasons.push(`Loom CDN returned HTTP ${response.status}`);
        } else {
          const nodeStream = Readable.fromWeb(
            response.body as Parameters<typeof Readable.fromWeb>[0],
          );
          await pipeline(nodeStream, createWriteStream(outputPath));
          if (existsSync(outputPath)) return outputPath;
          reasons.push('Loom CDN stream produced no file');
        }
      } catch (e: unknown) {
        reasons.push(`Loom CDN download failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    onWarning?.(`Loom video download failed — ${reasons.join('; ')}`);
    return null;
  }

  private async fetchVideoUrl(videoId: string): Promise<string | null> {
    // Loom exposes video URLs through their fetch endpoint
    try {
      const response = await fetch(
        `https://www.loom.com/api/campaigns/sessions/${videoId}/transcoded-url`,
        {
          method: 'POST',
          headers: GRAPHQL_HEADERS,
          body: JSON.stringify({}),
        },
      );

      if (response.ok) {
        const data = (await response.json()) as { url?: string };
        if (data.url) return data.url;
      }
    } catch {
      // Try alternative approach
    }

    // Fallback: query the GraphQL API for video source URL
    const data = await loomGraphQL<{ getVideo: { source_url?: string; video_url?: string } }>(
      `query GetVideoUrl($videoId: ID!, $password: String) {
        getVideo(id: $videoId, password: $password) {
          ... on RegularUserVideo {
            source_url
          }
        }
      }`,
      { videoId, password: null },
    );

    return data?.getVideo?.source_url ?? null;
  }
}

function flattenComments(comments: LoomComment[]): IVideoComment[] {
  const result: IVideoComment[] = [];

  for (const comment of comments) {
    result.push({
      author: comment.user_name ?? 'Unknown',
      text: comment.plain_content,
      time: comment.time_stamp != null ? timestampFromMs(comment.time_stamp) : undefined,
      createdAt: comment.createdAt,
    });

    if (comment.children_comments?.length) {
      for (const child of comment.children_comments) {
        result.push({
          author: child.user_name ?? 'Unknown',
          text: child.plain_content,
          time: child.time_stamp != null ? timestampFromMs(child.time_stamp) : undefined,
          createdAt: child.createdAt,
        });
      }
    }
  }

  return result;
}
