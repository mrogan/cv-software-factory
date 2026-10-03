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
          exclude: ['packages/store/test/**', 'packages/*/test/database/**', 'apps/factory/test/**'],
        },
      },
      {
        // Against a real Postgres, which the setup provides.
        extends: true,
        test: {
          name: 'database',
          include: [
            'packages/store/test/**/*.test.ts',
            'packages/*/test/database/**/*.test.ts',
            'apps/factory/test/**/*.test.ts',
          ],
          globalSetup: ['packages/store/test/postgres.ts'],
        },
      },
    ],
  },
});
