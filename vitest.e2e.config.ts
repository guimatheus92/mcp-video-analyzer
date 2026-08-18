import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Required on Windows (see CLAUDE.md), and the unit + smoke configs
    // already set it. It was missing here only because the e2e suite ran on
    // ubuntu exclusively — `npm run test:formats` now runs one of these files
    // on the windows CI job.
    pool: 'forks',
    include: ['test/e2e/**/*.e2e.test.ts'],
    // Above the 300s yt-dlp download ceiling in YtDlpAdapter.downloadVideo,
    // plus room for frame extraction and a cold-runner tessdata fetch. At
    // 120s a slow-but-working download died on vitest's timeout instead of
    // reaching the deliberate isVideoUnavailable skip — and a test that goes
    // red for reasons unrelated to the code is how narrow skips get widened.
    testTimeout: 420_000,
    hookTimeout: 60_000,
  },
});
