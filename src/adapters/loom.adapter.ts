import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { existsSync, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type {
  ITranscriptEntry,
  IVideoMetadata,
  IVideoComment,
  IChapter,
  IAdapterCapabilities,
} from '../types.js';
import type { IVideoAdapter } from './adapter.interface.js';
import { detectPlatform, extractLoomId } from '../utils/url-detector.js';
import { parseVtt } from '../utils/vtt-parser.js';

const execFile = promisify(execFileCb);

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

  async downloadVideo(url: string, destDir: string): Promise<string | null> {
    const videoId = extractLoomId(url);
    const outputPath = join(destDir, `${videoId ?? 'loom_video'}.mp4`);

    // Strategy 1: yt-dlp (best quality, handles edge cases)
    const ytDlp = await findYtDlp();
    if (ytDlp) {
      try {
        await execFile(ytDlp.bin, [...ytDlp.prefix, '-o', outputPath, '--no-warnings', '-q', url], {
          timeout: 120000,
        });
        if (existsSync(outputPath)) return outputPath;
      } catch {
        // Fall through to direct download
      }
    }

    // Strategy 2: Direct HTTP download via Loom CDN URL
    if (!videoId) return null;
    const videoUrl = await this.fetchVideoUrl(videoId);
    if (videoUrl) {
      try {
        const response = await fetch(videoUrl);
        if (response.ok && response.body) {
          const nodeStream = Readable.fromWeb(
            response.body as Parameters<typeof Readable.fromWeb>[0],
          );
          await pipeline(nodeStream, createWriteStream(outputPath));
          if (existsSync(outputPath)) return outputPath;
        }
      } catch {
        // Download failed
      }
    }

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

interface YtDlpCommand {
  bin: string;
  prefix: string[];
}

async function findYtDlp(): Promise<YtDlpCommand | null> {
  for (const bin of ['yt-dlp', 'yt-dlp.exe']) {
    try {
      await execFile(bin, ['--version'], { timeout: 5000 });
      return { bin, prefix: [] };
    } catch {
      // not found, try next
    }
  }

  // Try python module
  try {
    await execFile('python', ['-m', 'yt_dlp', '--version'], { timeout: 5000 });
    return { bin: 'python', prefix: ['-m', 'yt_dlp'] };
  } catch {
    return null;
  }
}
