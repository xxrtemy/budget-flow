import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    pool: 'forks',
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
