/**
 * The test files in a checkout, and the files a pull request changed. Node alone, so the gates run from a sparse
 * checkout of this repository.
 */
import { glob, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Test files by the usual names, outside dependencies and build output. */
export const TEST_FILE = /(^|\/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$/;

/** Files under a tests folder (test/, tests/, __tests__/), which test files may import: fixtures and helpers. */
export const TEST_SUPPORT = /(^|\/)(test|tests|__tests__)\//;

const IGNORED = /(^|\/)(node_modules|dist|build|coverage|\.git)\//;

/** Every file in a checkout matching `pattern`, by its path relative to the checkout, with its contents. */
export async function filesIn(dir: string, pattern: RegExp): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for await (const path of glob('**/*', { cwd: dir })) {
    if (IGNORED.test(`${path}/`) || !pattern.test(path)) continue;
    try {
      files.set(path, await readFile(join(dir, path), 'utf-8'));
    } catch {
      // A folder that matched the pattern.
    }
  }
  return files;
}
