/**
 * The scope fence: a runner's patch may change only the files its spec's scope names. The line checks every patch
 * before the GitHub worker sees it, so a patch outside its scope never reaches GitHub. It is deterministic, and the
 * agent's own words have no part in it.
 *
 * A scope entry is a file (`src/money.ts`), a folder ending in `/` (`test/`), or a pattern with `*` (one path
 * segment) or `**` (any number). Whatever the scope says, a patch may never change the workflows, the deployment, or
 * a path the repository's CODEOWNERS gives a person.
 */
import { filesIn } from '../github/patches.ts';
import { inScope, NEVER, ownedPaths } from '../github/paths.ts';

export { NEVER, ownedPaths };

export interface Fenced {
  ok: boolean;
  /** Every path the patch changes. */
  paths: string[];
  /** Those outside the scope, or always out of bounds. */
  outside: string[];
}

export function fence(patch: string, scope: readonly string[], owned: readonly string[] = []): Fenced {
  const paths = [...new Set(filesIn(patch).map((f) => f.path))];
  const forbidden = [...NEVER, ...owned];
  const outside = paths.filter((path) => !inScope(path, scope) || inScope(path, forbidden));
  return { ok: outside.length === 0, paths, outside };
}
