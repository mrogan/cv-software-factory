import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A release pull request runs no tests (check.yml's `release` kind): it changes only the changelog, the release
 * manifest and the version line of package.json, and nothing the tests run reads any of them, so the commit on main
 * it is made on passing the tests stands for it. Its static half still runs, and its JSON is linted there.
 */
const named = (pattern: string, ...paths: string[]) =>
  execFileSync('git', ['grep', '-lE', pattern, '--', ...paths], { encoding: 'utf-8' })
    .split('\n')
    .filter(Boolean);

describe('the files a release changes', () => {
  it('are named, but in prose, only where they are released or checked, never read from the checkout', () => {
    expect(named('CHANGELOG|release-please-manifest', ':!*.md', ':!scripts/release-files.test.ts')).toEqual([
      // The kind job, which tells a release by them.
      '.github/workflows/check.yml',
      // release-please, which reads the manifest from main through GitHub's API.
      'apps/factory/src/github/releases.ts',
      // Biome leaves the manifest as release-please writes it.
      'biome.json',
      'release-please-config.json',
    ]);
  });

  it('include a version no code reads', () => {
    const code = ['*.ts', '*.tsx', '*.js', '*.mjs', '*.cjs', '*.mts'];
    const readers = named('package\\.json', ...code).filter((file) => /version/i.test(readFileSync(file, 'utf-8')));
    expect(readers).toEqual([
      // A package.json of its own, written for a scratch copy.
      'apps/runner/test/prepare.test.ts',
      // Invented work items, whose changed files are named and whose releases have versions.
      'packages/samples/src/items/1262-pino.ts',
      'packages/samples/src/items/1276-otel-rollback.ts',
    ]);
  });
});
