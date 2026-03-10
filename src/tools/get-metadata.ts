import type { FastMCP } from 'fastmcp';
import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getAdapter } from '../adapters/adapter.interface.js';

const GetMetadataSchema = z.object({
  url: z.string().url().describe('Video URL (Loom share link or direct mp4/webm URL)'),
});

export function registerGetMetadata(server: FastMCP): void {
  server.addTool({
    name: 'get_metadata',
    description: `Get video metadata, comments, chapters, and AI summary from a video URL.

Returns structured metadata without downloading the video or extracting frames.
Faster than analyze_video when you only need metadata.

Supports: Loom (loom.com/share/...) and direct video URLs (.mp4, .webm, .mov).`,
    parameters: GetMetadataSchema,
    annotations: {
      title: 'Get Metadata',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    execute: async (args) => {
      const { url } = args;

      let adapter;
      try {
        adapter = getAdapter(url);
      } catch (error) {
        if (error instanceof UserError) throw error;
        throw new UserError(`Failed to detect video platform for URL: ${url}`);
      }

      const warnings: string[] = [];

      const [metadata, comments, chapters, aiSummary] = await Promise.all([
        adapter.getMetadata(url).catch((e: unknown) => {
          warnings.push(`Failed to fetch metadata: ${e instanceof Error ? e.message : String(e)}`);
          return {
            platform: adapter.name as 'loom' | 'direct' | 'unknown',
            title: 'Unknown',
            duration: 0,
            durationFormatted: '0:00',
            url,
          };
        }),
        adapter.getComments(url).catch((e: unknown) => {
          warnings.push(`Failed to fetch comments: ${e instanceof Error ? e.message : String(e)}`);
          return [];
        }),
        adapter.getChapters(url).catch(() => []),
        adapter.getAiSummary(url).catch(() => null),
      ]);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ metadata, comments, chapters, aiSummary, warnings }, null, 2),
          },
        ],
      };
    },
  });
}
