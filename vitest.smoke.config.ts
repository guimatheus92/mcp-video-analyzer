import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    pool: 'forks',
    include: ['test/smoke/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 20_000,
  },
});
