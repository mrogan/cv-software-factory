/**
 * Which paths a patch may change, as both the line's scope fence and the GitHub worker read them. The worker checks
 * again what the line checked: the fence is a fast answer, and the worker, which holds the App's key, is the last.
 *
 * A path entry is a file (`src/money.ts`), a folder ending in `/` (`test/`), or a pattern with `*` (one path
 * segment) or `**` (any number). Whatever a scope says, a patch may never change the workflows, the deployment, or a
 * path the repository's CODEOWNERS gives a person.
 */

/** Never in a patch: the rules of the line, in the app's repository. */
export const NEVER = ['.github/', 'deploy/'];

/** Where GitHub looks for a CODEOWNERS file. */
export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

export const pattern = (entry: string) =>
  new RegExp(
    `^${entry
      .split(/(\*\*\/?|\*)/)
      .map((part) =>
        part.startsWith('**') ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'),
      )
      .join('')}${entry.endsWith('/') ? '.*' : ''}$`,
  );

export const inScope = (path: string, scope: readonly string[]) => scope.some((entry) => pattern(entry).test(path));

/**
 * The paths a CODEOWNERS file gives anyone, as scope entries: `/deploy/` is `deploy/`, `/Dockerfile` is `Dockerfile`,
 * and an entry with no leading slash matches anywhere.
 */
export function ownedPaths(codeowners: string): string[] {
  return codeowners
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[0] ?? '')
    .filter(Boolean)
    .map((path) => (path.startsWith('/') ? path.slice(1) : `**/${path}`));
}
