/**
 * Check that a commit message or pull request title follows Conventional Commits.
 *
 *     node scripts/commit-msg.ts .git/COMMIT_EDITMSG    # the commit-msg hook
 *     node scripts/commit-msg.ts --title "fix: …"       # CI, on a pull request title
 *     node scripts/commit-msg.ts --title "chore: …" --any-length    # CI, on one of Dependabot's
 *
 * Pull requests are squash-merged, so the title is what lands on `main`; CI checks it with the same rules. Dependabot's
 * titles are the one exception to the length: it writes them itself, naming the versions and the directory, and some
 * image tags are long enough that no setting of ours keeps them under it.
 */
import { readFileSync } from 'node:fs';

export const TYPES = ['feat', 'fix', 'docs', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'] as const;

const MAX_HEADER = 100;
const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[a-z0-9-]+)\))?(?<breaking>!)?: (?<subject>.+)$/;

/** Messages git writes itself, which are never the commit that lands on `main`. */
const GIT_GENERATED = /^(Merge |Revert "|fixup! |squash! |amend! )/;

/** Returns the problems with a message's first line; an empty list means it passes. */
export function problems(message: string, { anyLength = false } = {}): string[] {
  const header = message.split('\n').find((line) => line.trim() && !line.startsWith('#')) ?? '';
  if (GIT_GENERATED.test(header)) return [];

  const match = HEADER.exec(header);
  if (!match?.groups) {
    return [`"${header}" should look like "type(scope): subject", for example "fix(console): keep the clock in step"`];
  }

  const { type = '', subject = '' } = match.groups;
  const found: string[] = [];
  if (!(TYPES as readonly string[]).includes(type)) {
    found.push(`"${type}" is not a type we use; choose one of ${TYPES.join(', ')}`);
  }
  if (subject.endsWith('.')) found.push('leave the full stop off the subject');
  if (!anyLength && header.length > MAX_HEADER)
    found.push(`keep the first line to ${MAX_HEADER} characters (it is ${header.length})`);
  return found;
}

if (import.meta.main) {
  const [flag, value, ...rest] = process.argv.slice(2);
  const message = flag === '--title' ? (value ?? '') : readFileSync(flag ?? '', 'utf-8');
  const found = problems(message, { anyLength: rest.includes('--any-length') });
  if (found.length) {
    console.error(`Not a Conventional Commit (https://www.conventionalcommits.org):\n  - ${found.join('\n  - ')}`);
    process.exit(1);
  }
}
