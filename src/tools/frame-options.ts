import { z } from 'zod';

/**
 * Per-call override for the width cap applied to emitted frames.
 *
 * The 800 px default suits the common case — talking-head clips, Reels, bug
 * repros — where the subject fills the frame. It is the wrong size for **dense
 * UI captures** (trading terminals, dashboards, IDEs, spreadsheets), whose
 * entire payload is small text: an unscaled 1920x1080 screen recording lands at
 * 800x450 and a 15 px UI font drops below what a vision model can resolve.
 *
 * A per-call parameter rather than only an environment variable, because the
 * right width depends on the video, not on the server: the process starts once
 * per session, so `MCP_FRAME_MAX_WIDTH` cannot be varied between an overview of
 * a YouTube clip and a close read of a screen recording.
 */
export const maxWidthParam = z
  .number()
  .int()
  .min(0)
  .max(7680)
  .optional()
  .describe(
    'Width cap for returned frames, in pixels; 0 keeps the source resolution. ' +
      'Defaults to 800 (or MCP_FRAME_MAX_WIDTH). Raise it when the video is a screen ' +
      'recording whose meaning lives in small text — terminals, dashboards, IDEs. ' +
      'Native frames cost several times more context than the default.',
  );
