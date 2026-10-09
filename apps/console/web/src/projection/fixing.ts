/**
 * A fix's way through Build, Gates and Review, from its events: each attempt the coder pushed, what the gates and
 * the reviewer made of it and why it went back, and the review thread with the rules it cites. And the pictures for
 * the moments a fix waits on Martin: the pull request he is asked to merge, or what the mechanism that held it
 * judged, chosen by the cause the hold records.
 *
 * Every figure here is read from events the line writes; where an event does not say something (which finding a
 * later round answered), the console does not guess it.
 *
 * Three counts, each with its own word: a round is the coder's (one for each attempt it pushes, as the line counts
 * them), a review is the reviewer's (two at most), and a patch is anything the coder handed back that the scope fence
 * judged, pushed or refused.
 */
import type { PayloadOf, PublicEvent, Stage } from '@software-factory/events';
import { inScope, returnWords } from '@software-factory/events';
import { RULES } from './app.ts';
import type { Hold, ItemState } from './items.ts';
import type { Picture } from './reel.ts';

type Review = PayloadOf<'review.submitted'>;
type GateRun = PayloadOf<'gate.finished'>;

/** One patch the coder pushed, and what became of it. */
export interface Attempt {
  attempt: number;
  /** The commit the gates ran on, once they started. */
  commit: string | undefined;
  /** How the coder came to it: a first patch with its failing test first or not, or its own session resumed. */
  how: 'tests first' | 'no new test' | 'resumed';
  files: number;
  added: number;
  removed: number;
  gates: AttemptGates | undefined;
  review: AttemptReview | undefined;
  /** Why it went back to Build, when it did: the stage that sent it, and why in a few words. */
  returned: { from: Stage; detail: string } | undefined;
}

export interface AttemptGates {
  state: 'running' | 'passed' | 'failed';
  /** The required checks finished so far: passed, and in all. */
  passed: number;
  total: number;
  failed: string[];
  /** The tests-first signal, not required: whether its tests failed on the base, and the figure its summary gives. */
  testsFirst: { failedOnBase: boolean; figure: string | undefined } | undefined;
  /** Every check's latest result on the attempt's commit. */
  runs: GateRun[];
}

export interface AttemptReview {
  /** Which review it was: the first, or the second. */
  number: number;
  verdict: Review['verdict'];
  blocking: number;
  suggestions: number;
}

/** One review, as the reviewer posted it. */
export interface ThreadReview {
  /** Which review it was: the first, or the second. */
  number: number;
  at: number;
  /** The attempt it reviewed. */
  attempt: number | undefined;
  verdict: Review['verdict'];
  note: string;
  findings: Finding[];
}

export interface Finding {
  path: string;
  line: number;
  blocking: boolean;
  comment: string;
  /** The rule it cites, with its words where the console knows them. */
  rule: { number: number; title: string | undefined; text: string | undefined } | undefined;
  /** The spec's criterion it cites, in full. */
  criterion: { number: number; text: string | undefined } | undefined;
  /** Whether it cites the ticket: the spec or the change goes beyond what the ticket asks. */
  ticket: boolean;
}

/** The tests-first check, by the name its workflow gives it. It is a signal, not a required check. */
export const isTestsFirst = (check: string) => /tests[ -]first$/i.test(check);

/** "2 of 2": the figure in a check's summary, where it gives one. */
const figureIn = (summary: string | undefined) => summary?.match(/\d+ of \d+/)?.[0];

/** Each patch the factory's coder pushed, in order, with its gates, its review and its return. */
export function attempts(item: ItemState): Attempt[] {
  const list: Attempt[] = [];
  let current: Attempt | undefined;
  let reviews = 0;
  const runs = new Map<string, GateRun>();
  const settle = () => {
    if (!current?.gates) return;
    const all = [...runs.values()];
    const required = all.filter((run) => run.required);
    const tests = all.find((run) => !run.required && isTestsFirst(run.check));
    current.gates = {
      ...current.gates,
      passed: required.filter((run) => run.conclusion !== 'failure').length,
      total: required.length,
      failed: required.filter((run) => run.conclusion === 'failure').map((run) => run.check),
      // The check passes when the change's new tests fail on the base, as a test written before its fix must: its
      // success is their failure there.
      testsFirst: tests && { failedOnBase: tests.conclusion === 'success', figure: figureIn(tests.summary) },
      runs: all,
    };
  };
  for (const event of item.events) {
    switch (event.type) {
      case 'pull-request.pushed': {
        // Dependabot's pull requests and Martin's are not the coder's attempts.
        if (event.actor !== 'coder') break;
        const { attempt, testsFirst, files } = event.payload;
        current = {
          attempt,
          commit: undefined,
          how: attempt > 1 ? 'resumed' : testsFirst ? 'tests first' : 'no new test',
          files: files.length,
          added: files.reduce((n, f) => n + f.added, 0),
          removed: files.reduce((n, f) => n + f.removed, 0),
          gates: undefined,
          review: undefined,
          returned: undefined,
        };
        list.push(current);
        break;
      }
      case 'gates.started':
        // A run on a newer commit of the same push (main merged in) replaces the one before.
        if (!current) break;
        current.commit = event.payload.commit;
        current.gates = { state: 'running', passed: 0, total: 0, failed: [], testsFirst: undefined, runs: [] };
        runs.clear();
        break;
      case 'gate.finished':
        if (current?.commit !== event.payload.commit) break;
        runs.set(event.payload.check, event.payload);
        settle();
        break;
      case 'gates.finished':
        if (current?.commit !== event.payload.commit || !current.gates) break;
        current.gates.state = event.payload.conclusion;
        break;
      case 'review.submitted': {
        reviews += 1;
        if (!current) break;
        const blocking = event.payload.findings.filter((f) => f.blocking).length;
        current.review = {
          number: reviews,
          verdict: event.payload.verdict,
          blocking,
          suggestions: event.payload.findings.length - blocking,
        };
        break;
      }
      case 'work.returned': {
        if (!current || event.payload.to !== 'build') break;
        current.returned = { from: event.payload.from, detail: returnWords(event.payload) };
        break;
      }
    }
  }
  return list;
}

/** Every review, with each finding's rule and criterion in full. */
export function reviewThread(item: ItemState, spec: PayloadOf<'spec.written'> | undefined): ThreadReview[] {
  let attempt: number | undefined;
  const reviews: ThreadReview[] = [];
  for (const event of item.events) {
    if (event.type === 'pull-request.pushed' && event.actor === 'coder') attempt = event.payload.attempt;
    if (event.type !== 'review.submitted') continue;
    const { verdict, note, findings } = event.payload;
    reviews.push({
      number: reviews.length + 1,
      at: Date.parse(event.ts),
      attempt,
      verdict,
      note,
      findings: findings.map((f) => {
        const criterion = f.criterion !== undefined ? spec?.criteria[f.criterion - 1] : undefined;
        return {
          path: f.path,
          line: f.line,
          blocking: f.blocking,
          comment: f.comment,
          ticket: f.ticket === true,
          rule:
            f.rule !== undefined
              ? { number: f.rule, title: RULES[f.rule]?.title, text: RULES[f.rule]?.text }
              : undefined,
          criterion:
            f.criterion !== undefined
              ? {
                  number: f.criterion,
                  text: criterion && `GIVEN ${criterion.given} WHEN ${criterion.when} THEN ${criterion.expect}`,
                }
              : undefined,
        };
      }),
    });
  }
  return reviews;
}

const ofType = <K extends PublicEvent['type']>(item: ItemState, type: K) =>
  item.events.filter((event): event is PublicEvent<K> => event.type === type);

const coderPushes = (item: ItemState) => ofType(item, 'pull-request.pushed').filter((event) => event.actor === 'coder');

interface Refusal {
  patch: number;
  output: string;
  /** The paths it refused, from the fence's verdict on each file. */
  refused: string[];
}

/**
 * The coder's patches the scope fence refused since Martin last answered a hold, which is the count the line holds
 * at, each numbered among every patch the fence judged.
 */
function refusals(item: ItemState): Refusal[] {
  let patches = 0;
  let since: Refusal[] = [];
  for (const event of item.events) {
    if (event.type === 'pull-request.pushed' && event.actor === 'coder') patches += 1;
    if (event.type === 'hold.answered') since = [];
    if (event.type === 'action.refused' && event.payload.mechanism === 'scope-fence') {
      patches += 1;
      const refused = (event.payload.files ?? []).filter((file) => !file.allowed).map((file) => file.path);
      since.push({ patch: patches, output: event.payload.output, refused });
    }
  }
  return since;
}

/**
 * The picture for a fix that waits on Martin: the pull request he is asked to merge, or what the mechanism that held
 * it judged, by the hold's cause. Nothing for any other wait, or for a hold whose events lack what its picture shows:
 * the card then shows the evidence, and the hold's reason says why it waits.
 */
export function waitPicture(item: ItemState): Picture | undefined {
  const hold = item.hold;
  if (!hold || item.dependency) return undefined;
  switch (hold.cause) {
    case 'merge':
      return mergePicture(item);
    case 'scope':
      return scopePicture(item);
    case 'tests-first':
      return testsPassPicture(item);
    case 'spend':
      return spendPicture(item, hold);
    case 'review':
      return blockingPicture(item);
    default:
      return undefined;
  }
}

/** The pull request Martin is asked to merge, with its whole change: every round together, as a merge brings it in. */
function mergePicture(item: ItemState): Picture | undefined {
  const final = coderPushes(item).at(-1)?.payload;
  if (!final) return undefined;
  const last = attempts(item).at(-1);
  const scope = ofType(item, 'spec.written').at(-1)?.payload.scope;
  const review = last?.review;
  return {
    type: 'merge',
    pullRequest: final.number,
    title: final.title,
    checks: { passed: last?.gates?.passed ?? 0, total: last?.gates?.total ?? 0 },
    testsFirst: last?.gates?.testsFirst,
    review: review && { suggestions: review.suggestions, number: review.number },
    files: final.whole.length,
    added: final.whole.reduce((n, f) => n + f.added, 0),
    removed: final.whole.reduce((n, f) => n + f.removed, 0),
    inScope: Boolean(scope && final.whole.every((file) => inScope(file.path, scope))),
  };
}

/** The scope fence's last refusal, in its own words, and the one before it since Martin last answered. */
function scopePicture(item: ItemState): Picture | undefined {
  const refused = refusals(item);
  const refusal = refused.at(-1);
  if (!refusal) return undefined;
  const earlier = refused.at(-2);
  return {
    type: 'scope',
    patch: refusal.patch,
    refusals: refused.length,
    output: refusal.output,
    earlier: earlier && {
      patch: earlier.patch,
      same: refusal.refused.length > 0 && earlier.refused.join() === refusal.refused.join(),
    },
    reachedGitHub: coderPushes(item).length > 0,
  };
}

/** The tests-first check's own output, where it failed on the last attempt: the change's tests pass on the base. */
function testsPassPicture(item: ItemState): Picture | undefined {
  const tests = attempts(item)
    .at(-1)
    ?.gates?.runs.find((run) => !run.required && isTestsFirst(run.check));
  if (tests?.conclusion !== 'failure') return undefined;
  return { type: 'tests-pass', output: tests.output ?? tests.summary ?? '' };
}

/** What the work item spent, by agent, against the cap the hold records. */
function spendPicture(item: ItemState, hold: Hold): Picture | undefined {
  if (hold.limitUsd === undefined) return undefined;
  const steps = ofType(item, 'model.called');
  const agents = new Map<string, { agent: string; cost: number; steps: number }>();
  for (const { payload } of steps) {
    const row = agents.get(payload.agent) ?? { agent: payload.agent, cost: 0, steps: 0 };
    row.cost += payload.costUsd;
    row.steps += 1;
    agents.set(payload.agent, row);
  }
  const stopped = steps.at(-1)?.payload.agent;
  return {
    type: 'spend',
    stage: hold.stage,
    spent: item.spend,
    cap: hold.limitUsd,
    agents: [...agents.values()],
    // The step the cap stopped: the last one that called a model.
    stopped: stopped ? { agent: stopped, step: agents.get(stopped)?.steps ?? 1 } : undefined,
  };
}

/** The last review's findings still blocking, each with the reviews that blocked the same thing. */
function blockingPicture(item: ItemState): Picture | undefined {
  const reviews = ofType(item, 'review.submitted');
  const latest = reviews.at(-1)?.payload;
  // An escalation holds at Review too, with no findings to show: its reason says why.
  const open = latest?.verdict === 'changes-requested' ? latest.findings.filter((f) => f.blocking) : [];
  if (!open.length) return undefined;
  return {
    type: 'blocking',
    reviews: reviews.length,
    findings: open.map((f) => ({
      where: `${f.path}:${f.line}`,
      cites:
        f.rule !== undefined
          ? `rule ${f.rule}${RULES[f.rule] ? `, ${RULES[f.rule]?.title.toLowerCase()}` : ''}`
          : f.criterion !== undefined
            ? `criterion ${f.criterion}`
            : undefined,
      comment: f.comment,
      reviews: reviews.flatMap((r, i) =>
        r.payload.findings.some(
          (g) => g.blocking && g.path === f.path && g.rule === f.rule && g.criterion === f.criterion,
        )
          ? [i + 1]
          : [],
      ),
    })),
  };
}
