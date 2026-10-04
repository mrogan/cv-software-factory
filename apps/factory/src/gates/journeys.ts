/**
 * The journeys gate: the probes and the crawler, run against a pull request's base and its change, and compared.
 * The app is broken on purpose, so a check that fails on both says nothing about the change; the gate fails only on
 * a check that passes on the base and fails on the change, and fails on the change again when run a second time (a
 * check that fails once can be the network). A check the base could not tell about is reported, not failed on.
 */
import { cell } from './report.ts';

/** One check's result in one pass. */
export interface Seen {
  sense: string;
  check: string;
  route: string;
  failed: boolean;
  /** Why the check could not tell, when it could not. */
  trouble?: string;
  message?: string;
}

export interface Comparison {
  /** Pass on the base, fail on the change twice: these fail the gate. */
  regressions: Seen[];
  /** Fail on the base, pass on the change. */
  fixed: Seen[];
  /** Fail on both: the app as it was. */
  unchanged: Seen[];
  /** Failed on the change once, then passed. */
  flaky: Seen[];
  /** Fail on the change, where the base could not tell. */
  unsure: Seen[];
  checks: number;
}

export const keyOf = (s: Pick<Seen, 'sense' | 'check' | 'route'>) => `${s.sense} ${s.check} ${s.route}`;

export async function compareJourneys(
  observe: (app: string) => Promise<Seen[]>,
  base: string,
  change: string,
): Promise<Comparison> {
  const index = (seen: Seen[]) => new Map(seen.map((s) => [keyOf(s), s]));
  const before = index(await observe(base));
  const first = await observe(change);
  const failing = first.filter((s) => s.failed);
  const candidates = failing.filter((s) => !before.get(keyOf(s))?.failed && !before.get(keyOf(s))?.trouble);
  const again = candidates.length ? index(await observe(change)) : new Map<string, Seen>();
  const after = index(first);
  return {
    regressions: candidates.filter((s) => again.get(keyOf(s))?.failed),
    flaky: candidates.filter((s) => !again.get(keyOf(s))?.failed),
    unsure: failing.filter((s) => !before.get(keyOf(s))?.failed && before.get(keyOf(s))?.trouble),
    unchanged: failing.filter((s) => before.get(keyOf(s))?.failed),
    fixed: [...before.values()].filter((s) => s.failed && after.has(keyOf(s)) && !after.get(keyOf(s))?.failed),
    checks: first.length,
  };
}

const row = (s: Seen) =>
  `| ${cell(s.sense)} | ${cell(s.check)} | \`${cell(s.route)}\` | ${cell(s.message ?? s.trouble ?? '')} |`;
const table = (seen: Seen[]) =>
  `| Sense | Check | Route | What it saw |\n|---|---|---|---|\n${seen.map(row).join('\n')}`;

export function summary(c: Comparison): string {
  const parts = [
    '## Journeys',
    c.regressions.length
      ? `${c.regressions.length} check${c.regressions.length === 1 ? '' : 's'} that pass on the base fail on this change, twice.\n\n${table(c.regressions)}`
      : `Nothing that passes on the base fails on this change (${c.checks} checks).`,
  ];
  if (c.fixed.length) parts.push(`### Fixed\n\nFail on the base and pass on this change.\n\n${table(c.fixed)}`);
  if (c.flaky.length)
    parts.push(`### Failed once\n\nFailed on the change, then passed when run again.\n\n${table(c.flaky)}`);
  if (c.unsure.length)
    parts.push(`### Could not compare\n\nThe base could not tell about these.\n\n${table(c.unsure)}`);
  if (c.unchanged.length)
    parts.push(`<details><summary>${c.unchanged.length} fail on both</summary>\n\n${table(c.unchanged)}\n\n</details>`);
  return parts.join('\n\n');
}
