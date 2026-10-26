/**
 * Which paths a patch may change, as both the line's scope fence and the GitHub worker read them. The worker checks
 * again what the line checked: the fence is a fast answer, and the worker, which holds the App's key, is the last.
 *
 * A path entry is a file (`src/money.ts`), a folder ending in `/` (`test/`), or a pattern with `*` (one path
 * segment) or `**` (any number). Whatever a scope says, a patch may never change the workflows, the deployment, or a
 * path the repository's CODEOWNERS gives a person.
 */

import { inScope, pattern } from '@software-factory/events';

/** Never in a patch: the rules of the line, in the app's repository. */
export const NEVER = ['.github/', 'deploy/'];

/**
 * A path a patch may name: relative, with no empty, `.` or `..` segment, and no backslash or control character, C1's
 * (U+0080 to U+009F) included, any of which a terminal or a page that shows the path could act on.
 */
export function plainPath(path: string): boolean {
  return (
    !path.startsWith('/') &&
    !/[\\\p{Cc}]/u.test(path) &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

/** Where GitHub looks for a CODEOWNERS file. */
export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

/** The scope's path rule, shared with the console, which marks each path a spec's scope allows. */
export { inScope, pattern };

/**
 * The paths a CODEOWNERS file gives anyone, as scope entries, read as GitHub reads them, or more widely where scope
 * entries cannot say it: `/deploy/` is `deploy/`, and an entry with no leading slash matches anywhere. An entry that
 * does not end in `/` names a file or a folder, so `/Dockerfile` is `Dockerfile` and `Dockerfile/`, everything in a
 * folder of that name. `?`, one character, is `*`, and `/` alone is everything.
 */
export function ownedPaths(codeowners: string): string[] {
  return codeowners
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[0] ?? '')
    .filter(Boolean)
    .map((path) => path.replaceAll('?', '*'))
    .map((path) => (path === '/' ? '**' : path.startsWith('/') ? path.slice(1) : `**/${path}`))
    .flatMap((path) => (path.endsWith('/') ? [path] : [path, `${path}/`]));
}

/**
 * The paths no patch may change, as scope entries: the workflows, the deployment, and those a CODEOWNERS file (the
 * first GitHub finds at a commit, or none) gives a person.
 */
export function protectedFrom(codeowners: string | null): string[] {
  return [...new Set([...NEVER, ...ownedPaths(codeowners ?? '')])];
}
