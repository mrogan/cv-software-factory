import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/*/test/**/*.test.ts', 'scripts/**/*.test.ts'],
    env: { LOG_LEVEL: 'silent' },
  },
});
