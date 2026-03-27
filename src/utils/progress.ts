/**
 * Progress reporting utility with descriptive messages.
 *
 * The MCP spec supports an optional `message` field in progress notifications.
 * FastMCP's TypeScript type omits it, but the runtime passes it through via spread.
 */

type ReportProgressFn = (progress: { progress: number; total?: number }) => Promise<void>;

export function createProgressReporter(reportProgress: ReportProgressFn, total = 100) {
  return async (progress: number, message?: string): Promise<void> => {
    const payload: { progress: number; total: number; message?: string } = { progress, total };
    if (message) {
      payload.message = message;
    }
    await reportProgress(payload as { progress: number; total?: number });
  };
}
