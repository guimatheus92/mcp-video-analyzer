import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    pool: 'forks',
    passWithNoTests: true,
    include: ['src/**/*.test.ts', 'src/**/*.integration.test.ts'],
    exclude: ['test/smoke/**', 'test/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.integration.test.ts'],
    },
  },
});
