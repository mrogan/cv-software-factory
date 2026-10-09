/**
 * The journeys gate: the probes and the crawler, run against a pull request's base and its change, and compared.
 * The app is broken on purpose, so a check that fails on both says nothing about the change; the gate fails only on
 * a check that passes on the base and fails on the change, and fails on the change again when run a second time (a
 * check that fails once can be the network). A check that passes on the base and cannot finish on the change (it
 * times out, or what it needs has gone) is as bad as one that fails: it fails the gate the same way, when it happens
 * twice. A check the base could not tell about is reported, not failed on.
 *
 * The base and the change are observed at once, and only what failed on the change is observed again.
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
  /** Pass on the base, and fail or cannot finish on the change, twice: these fail the gate. */
  regressions: Seen[];
  /** Fail on the base, pass on the change. */
  fixed: Seen[];
  /** Fail on both: the app as it was. */
  unchanged: Seen[];
  /** Failed, or could not finish, on the change once, then passed. */
  flaky: Seen[];
  /** Fail on the change, where the base could not tell. */
  unsure: Seen[];
  checks: number;
}

export const keyOf = (s: Pick<Seen, 'sense' | 'check' | 'route'>) => `${s.sense} ${s.check} ${s.route}`;

/**
 * Observes one app and says what each check saw. Given `only`, the checks wanted again, it may leave out the rest; it
 * may also run more than those, as a sense that cannot run one check alone does.
 */
export type Observe = (app: string, only?: readonly Seen[]) => Promise<Seen[]>;

export async function compareJourneys(observe: Observe, base: string, change: string): Promise<Comparison> {
  const index = (seen: Seen[]) => new Map(seen.map((s) => [keyOf(s), s]));
  const [seenOnBase, first] = await Promise.all([observe(base), observe(change)]);
  const before = index(seenOnBase);
  const failing = first.filter((s) => s.failed);
  // Passed cleanly on the base: no finding, and no trouble.
  const passed = (s: Seen) => {
    const was = before.get(keyOf(s));
    return was !== undefined ? !was.failed && !was.trouble : true;
  };
  const bad = (s: Seen | undefined) => s !== undefined && (s.failed || s.trouble !== undefined);
  const candidates = first.filter((s) => bad(s) && passed(s));
  const again = candidates.length ? index(await observe(change, candidates)) : new Map<string, Seen>();
  const after = index(first);
  return {
    regressions: candidates.filter((s) => bad(again.get(keyOf(s)))).map((s) => again.get(keyOf(s)) ?? s),
    flaky: candidates.filter((s) => !bad(again.get(keyOf(s)))),
    unsure: failing.filter((s) => !before.get(keyOf(s))?.failed && before.get(keyOf(s))?.trouble),
    unchanged: failing.filter((s) => before.get(keyOf(s))?.failed),
    fixed: [...before.values()].filter((s) => s.failed && after.has(keyOf(s)) && !after.get(keyOf(s))?.failed),
    checks: first.length,
  };
}

/**
 * What to run again to see `only` again: the probes, by id, that made them (a probe's checks are its id and what the
 * watch saw on its pages, such as `<id>/console`), and whether to crawl, since a crawl cannot look at one route alone.
 */
export function toRunAgain(only: readonly Seen[]): { probes: Set<string>; crawl: boolean } {
  return {
    probes: new Set(only.filter((s) => s.sense === 'probe').map((s) => s.check.split('/')[0] as string)),
    crawl: only.some((s) => s.sense === 'crawler'),
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
