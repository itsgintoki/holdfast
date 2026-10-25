import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    fileParallelism: false, // test files share one database
    setupFiles: ['./test/setup.ts'],
    env: { DATABASE_URL: 'postgres://holdfast:holdfast@localhost:5432/holdfast_test' },
  },
});

