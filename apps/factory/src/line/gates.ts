/**
 * The gates and Martin's merge, as events. GitHub never calls the factory, so the line reads each of its pull
 * requests through the GitHub worker, about once a minute, and appends what changed: the checks starting on a
 * commit (`gates.started`), each one finishing (`gate.finished`), all of them done (`gates.finished`), and the merge
 * (`pull-request.merged`). A pull request closed without a merge closes its work item.
 *
 * `gateEvents` is the decision, a pure function of what GitHub says and what the work item has already recorded, so
 * reading the same state again appends nothing. The gates are done when every check the ruleset requires has
 * finished on the commit, and every other check that started there; they pass when every required one passed. The
 * factory's own check runs (the reviewer's) are not gates, and are left out.
 */
import { type EventType, type NewEvent, type PayloadOf, VERSIONS } from '@software-factory/events';
import { APP_LOGIN } from '../github/current.ts';
import type { CheckRun, PullRequestState } from '../github/reads.ts';

/** The App, as GitHub names the app behind a check run: the factory's own runs (the reviewer's) are not gates. */
export const APP_SLUG = 'mrogan-software-factory';

/** What a work item has recorded about its pull request's gates and merge. */
export interface GateRecord {
  started: Set<string>;
  /** `commit check` for each check recorded as finished. */
  finished: Set<string>;
  done: Set<string>;
  merged: boolean;
  closed: boolean;
}

export function gateRecord(events: readonly { type: string; payload: unknown }[]): GateRecord {
  const record: GateRecord = {
    started: new Set(),
    finished: new Set(),
    done: new Set(),
    merged: false,
    closed: false,
  };
  for (const { type, payload } of events) {
    const p = payload as { commit?: string; check?: string };
    if (type === 'gates.started') record.started.add(p.commit ?? '');
    if (type === 'gate.finished') record.finished.add(`${p.commit} ${p.check}`);
    if (type === 'gates.finished') record.done.add(p.commit ?? '');
    if (type === 'pull-request.merged') record.merged = true;
    if (type === 'work-item.closed') record.closed = true;
  }
  return record;
}

const outcome = (conclusion: string | null): PayloadOf<'gate.finished'>['conclusion'] =>
  conclusion === 'success' || conclusion === 'neutral' ? 'success' : conclusion === 'skipped' ? 'skipped' : 'failure';

const durationOf = (run: CheckRun) =>
  run.startedAt && run.completedAt ? Math.max(0, Date.parse(run.completedAt) - Date.parse(run.startedAt)) : 0;

type Draft = {
  [K in EventType]: { type: K; actor: NewEvent['actor']; summary: string; payload: PayloadOf<K> };
}[EventType];

/**
 * The events a pull request's state calls for that the work item has not had yet, in order. `required` is the
 * checks the base branch's rulesets require, by name.
 */
export function gateEvents(
  pr: PullRequestState,
  runs: readonly CheckRun[],
  required: readonly string[],
  record: GateRecord,
): Draft[] {
  if (record.merged || record.closed) return [];
  if (pr.merged && pr.mergeCommit) {
    const by = pr.mergedBy === APP_LOGIN ? 'factory' : 'martin';
    return [
      {
        type: 'pull-request.merged',
        actor: by,
        summary: `${by === 'martin' ? 'Martin' : 'The factory'} merged PR #${pr.number}`,
        payload: { number: pr.number, commit: pr.mergeCommit, by },
      },
    ];
  }
  if (pr.state === 'closed') {
    return [
      {
        type: 'work-item.closed',
        actor: 'martin',
        summary: `PR #${pr.number} was closed without being merged`,
        payload: { outcome: 'no-change', reason: `Pull request #${pr.number} was closed without being merged` },
      },
    ];
  }

  const commit = pr.head.sha;
  // The latest run of each check, by name: a check run again replaces the run before.
  const latest = new Map<string, CheckRun>();
  for (const run of [...runs].sort((a, b) => a.id - b.id)) if (run.app !== APP_SLUG) latest.set(run.name, run);
  if (latest.size === 0) return [];
  const drafts: Draft[] = [];
  const pullRequest = pr.number;

  if (!record.started.has(commit)) {
    const checks = [...new Set([...required, ...latest.keys()])].map((name) => name.slice(0, 80)).slice(0, 40);
    drafts.push({
      type: 'gates.started',
      actor: 'actions',
      summary: `${checks.length} checks started on PR #${pullRequest}`,
      payload: { pullRequest, commit, checks },
    });
  }
  for (const run of latest.values()) {
    if (run.status !== 'completed' || record.finished.has(`${commit} ${run.name}`)) continue;
    const conclusion = outcome(run.conclusion);
    const summary = run.title?.trim().slice(0, 200);
    drafts.push({
      type: 'gate.finished',
      actor: 'actions',
      summary: `${run.name.slice(0, 80)} ${conclusion === 'success' ? 'passed' : conclusion === 'skipped' ? 'was skipped' : 'failed'}`,
      payload: {
        pullRequest,
        commit,
        check: run.name.slice(0, 80),
        conclusion,
        required: required.includes(run.name),
        durationMs: durationOf(run),
        ...(summary ? { summary } : {}),
      },
    });
  }

  const all = [...latest.values()];
  const waiting =
    required.some((name) => latest.get(name)?.status !== 'completed') || all.some((r) => r.status !== 'completed');
  if (!waiting && !record.done.has(commit)) {
    const judged = required.length ? all.filter((run) => required.includes(run.name)) : all;
    const failed = judged.filter((run) => outcome(run.conclusion) === 'failure').map((run) => run.name.slice(0, 80));
    const passed = all.filter((run) => outcome(run.conclusion) === 'success').length;
    drafts.push({
      type: 'gates.finished',
      actor: 'actions',
      summary: failed.length
        ? `${failed[0]} failed on PR #${pullRequest}`
        : `All ${judged.length} required checks passed on PR #${pullRequest}`,
      payload: {
        pullRequest,
        commit,
        conclusion: failed.length ? 'failed' : 'passed',
        passed,
        failed: failed.slice(0, 40),
      },
    });
  }
  return drafts;
}

/** A draft as an event of the work item, at its type's current version. */
export const asEvent = (workItem: string, draft: Draft, ts: string): NewEvent =>
  ({
    id: crypto.randomUUID(),
    ts,
    work_item: workItem,
    type: draft.type,
    version: VERSIONS[draft.type],
    actor: draft.actor,
    summary: draft.summary,
    payload: draft.payload,
    artifacts: [],
  }) as NewEvent;

export type { Draft };
