import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { LOG_LEVEL: 'silent' },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: ['packages/store/test/**'],
        },
      },
      {
        // Against a real Postgres, which the setup provides.
        extends: true,
        test: {
          name: 'store',
          include: ['packages/store/test/**/*.test.ts'],
          globalSetup: ['packages/store/test/postgres.ts'],
        },
      },
    ],
  },
});
