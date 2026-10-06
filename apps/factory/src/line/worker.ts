/**
 * The line after triage: takes tickets into Plan and carries each work item through its agents' steps, the gates
 * and review, to Martin's merge. What to do next is decided from the work item's events (`machine.ts`); this module
 * does it, and appends what happened.
 *
 * - A step runs in a runner (`Steps`), and its handback becomes events: the agent's result read through its schema
 *   (`agents/`), what the line did with it in GitHub, and one `model.called` with the step's calls. A step that hands
 *   back nothing, or a result its schema refuses, has failed; the step runs again, as a new job, up to a limit.
 * - At most one step at a time in each of Plan, Build and Review, and a ticket comes onto the line only when nothing
 *   is in Plan or waiting for Build (`queue.ts`). Each work item is leased while it is acted on.
 * - It reads its pull requests' gates and merges through the GitHub worker about once a minute (`gates.ts`).
 * - When the line stops, it deletes the Jobs of every step in hand and takes nothing new; their work is lost and
 *   nothing of it is recorded, so starting again runs those steps afresh from the last event.
 * - When a work item ends, merged or closed, its runners' volume is deleted.
 *
 * It acts in GitHub only through the GitHub worker, and every agent's model through the gateway: it holds no key.
 */
import type { PayloadOf, RawEvent } from '@software-factory/events';
import { upcast } from '@software-factory/events';
import type { EventWriter } from '@software-factory/store';
import { lineStopped } from '@software-factory/triage';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import { filesIn } from '../github/patches.ts';
import type { Reads } from '../github/reads.ts';
import { fence } from '../runners/scope.ts';
import type { StepOutcome, StepRequest } from '../runners/steps.ts';
import { AGENTS, type Agents } from './agents/index.ts';
import { asEvent, type Draft, gateEvents, gateRecord } from './gates.ts';
import { decide, fold, type LineAgent, type LineEvent, type Next, type WorkItemState } from './machine.ts';
import { stepCalls } from './model-calls.ts';
import { Queue, type QueueItem } from './queue.ts';

/** The runners, as the line uses them (`runners/steps.ts`). */
export interface Steps {
  run(request: StepRequest): Promise<StepOutcome>;
  finish(workItem: string): Promise<void>;
  cancel(): Promise<void>;
}

/** The GitHub worker, as the line uses it (`github/worker-client.ts`). */
export interface GitHubPort {
  act<T>(action: string, repo: string, args: Record<string, unknown>): Promise<T>;
  read<K extends keyof Reads>(
    read: K,
    repo: string,
    args: Record<string, unknown>,
  ): Promise<Awaited<ReturnType<Reads[K]>>>;
}

export interface LineOptions {
  /** As the factory's writer. */
  sql: Sql;
  events: EventWriter;
  steps: Steps;
  github: GitHubPort;
  log: Logger;
  /** The app's repository, as `owner/name`. */
  repo?: string;
  agents?: Agents;
  /** Who this worker is, as its leases name it. */
  me?: string;
  now?: () => Date;
  /** How often the gates and merges are read. */
  gatesEveryMs?: number;
  /**
   * False for a line that takes no work and only stops the steps in hand (the step API's) when the line stops.
   */
  takesWork?: boolean;
}

export const APP_REPOSITORY = 'mrogan/cv-worlds-worst-website';

/** A step that went wrong in a way the line counts against it: no handback, a result refused, an action refused. */
class StepFailed extends Error {
  override name = 'StepFailed';
}

/** How long a work item stays leased for an action that is not a step. */
const ACTION_LEASE_SECONDS = 300;
/** A step's lease: its deadline, ten minutes to prepare, and some to spare. */
const leaseFor = (deadlineSeconds: number) => deadlineSeconds + 900;

const STAGE: Record<LineAgent, 'plan' | 'build' | 'review'> = {
  planner: 'plan',
  coder: 'build',
  reviewer: 'review',
  describer: 'review',
};

export class Line {
  readonly #o: Required<Omit<LineOptions, 'me'>>;
  readonly #queue: Queue;
  /** The steps in hand, by work item, with the stage each holds. */
  readonly #inFlight = new Map<string, { stage: 'plan' | 'build' | 'review'; done: Promise<void> }>();
  #stopped = false;
  #gatesReadAt = Number.NEGATIVE_INFINITY;

  constructor(options: LineOptions) {
    this.#o = {
      repo: APP_REPOSITORY,
      agents: AGENTS,
      now: () => new Date(),
      gatesEveryMs: 60_000,
      takesWork: true,
      ...options,
    };
    this.#queue = new Queue(options.sql, options.me ?? `line-${process.pid}`);
  }

  /**
   * One pass: stops what is in hand if the line has stopped; otherwise reads the gates when they are due, takes a
   * ticket if there is room, and starts whatever each work item needs next. Steps carry on after it returns.
   */
  async tick(): Promise<void> {
    if (await lineStopped(this.#o.sql)) {
      if (!this.#stopped) {
        this.#stopped = true;
        this.#o.log.warn({ steps: [...this.#inFlight.keys()] }, 'the line stopped: deleting the steps in hand');
        await this.#o.steps.cancel();
      }
      return;
    }
    if (this.#stopped) this.#o.log.info('the line started again: carrying on from the last events');
    this.#stopped = false;
    if (!this.#o.takesWork) return;
    if (this.#o.now().getTime() - this.#gatesReadAt >= this.#o.gatesEveryMs) {
      this.#gatesReadAt = this.#o.now().getTime();
      await this.#readGates();
    }
    const taken = await this.#queue.admit();
    if (taken) this.#o.log.info({ workItem: taken }, 'a ticket came onto the line');
    for (const item of await this.#queue.free()) {
      if (this.#inFlight.has(item.workItem)) continue;
      await this.#advance(item).catch((error: unknown) =>
        this.#o.log.error({ workItem: item.workItem, err: errorOf(error) }, 'could not move a work item on'),
      );
    }
  }

  /** Waits for the steps in hand to end. */
  async idle(): Promise<void> {
    while (this.#inFlight.size) await Promise.all([...this.#inFlight.values()].map((s) => s.done));
  }

  /**
   * Runs until aborted, woken by every append (the line stopping or starting, a ticket opening) and every fifteen
   * seconds. Aborting stops the steps in hand, as stopping the line does, and lets go of every lease.
   */
  async run(abort: AbortSignal): Promise<void> {
    let wake = Promise.withResolvers<void>();
    const nudge = () => wake.resolve();
    const listening = await this.#o.sql.listen('events', nudge);
    abort.addEventListener('abort', nudge);
    try {
      while (!abort.aborted) {
        await this.tick().catch((error: unknown) =>
          this.#o.log.error({ err: errorOf(error) }, 'a pass of the line failed'),
        );
        const timer = setTimeout(nudge, 15_000);
        await wake.promise;
        clearTimeout(timer);
        wake = Promise.withResolvers<void>();
      }
    } finally {
      await listening.unlisten();
      if (this.#o.takesWork) {
        await this.#o.steps.cancel();
        await this.idle();
        await this.#queue.releaseAll();
      }
    }
  }

  /** Does what a work item needs next, until it is waiting or a step has started. */
  async #advance(first: QueueItem): Promise<void> {
    let item: QueueItem | undefined = first;
    // A few quick actions in a row (open the issue, then start the planner), never a loop without end.
    for (let actions = 0; item && actions < 5; actions++) {
      const events = await this.#events(item.workItem);
      const { stage, next } = decide(events, item);
      if (next.do === 'wait') {
        if (stage !== item.stage && (await this.#queue.claim(item.workItem, ACTION_LEASE_SECONDS))) {
          await this.#queue.release(item.workItem, stage);
        }
        return;
      }
      if (next.do === 'step') {
        // One step at a time in each of Plan, Build and Review.
        if ([...this.#inFlight.values()].some((s) => s.stage === STAGE[next.agent])) return;
        const claimed = await this.#queue.claim(item.workItem, leaseFor(this.#o.agents[next.agent].deadlineSeconds));
        if (!claimed) return;
        await this.#queue.move(item.workItem, stage);
        const workItem = item.workItem;
        const done = this.#step(claimed, next.agent, next.round, fold(events))
          .catch((error: unknown) =>
            this.#o.log.error({ workItem, err: errorOf(error) }, 'a step could not be recorded'),
          )
          .finally(() => this.#inFlight.delete(workItem));
        this.#inFlight.set(workItem, { stage: STAGE[next.agent], done });
        return;
      }
      const claimed = await this.#queue.claim(item.workItem, ACTION_LEASE_SECONDS);
      if (!claimed) return;
      try {
        await this.#act(claimed, next, fold(events));
      } catch (error) {
        await this.#release(item.workItem);
        throw error;
      }
      if (next.do === 'finish') {
        await this.#queue.release(item.workItem, 'ended');
        return;
      }
      await this.#release(item.workItem);
      item = await this.#queue.get(item.workItem);
    }
  }

  /**
   * Lets go of a work item, at the stage its events now put it in. Never at its end: only finishing ends a work item,
   * once its volume has gone, so a work item that ended while a step was in hand is still taken up and finished.
   */
  async #release(workItem: string): Promise<void> {
    const item = await this.#queue.get(workItem);
    if (!item) return;
    const { stage } = decide(await this.#events(workItem), item);
    await this.#queue.release(workItem, stage === 'ended' ? item.stage : stage);
  }

  /** An action that is not a step: quick, and done before the next. */
  async #act(item: QueueItem, next: Exclude<Next, { do: 'step' | 'wait' }>, state: WorkItemState): Promise<void> {
    const { workItem } = item;
    switch (next.do) {
      case 'open-issue': {
        const issue = await this.#openIssue(workItem, state);
        await this.#queue.setIssue(workItem, issue);
        this.#o.log.info({ workItem, issue }, 'opened the ticket’s issue');
        return;
      }
      case 'return':
        await this.#append(workItem, [
          {
            type: 'work.returned',
            actor: next.from === 'review' ? 'reviewer' : 'factory',
            summary: `Sent back to ${next.to} from ${next.from}`,
            payload: { from: next.from, to: next.to, reason: next.reason },
          },
        ]);
        await this.#queue.moved(workItem);
        return;
      case 'hold':
        await this.#append(workItem, [
          { type: 'hold.started', actor: 'factory', summary: holdLine(next.hold), payload: next.hold },
        ]);
        await this.#queue.moved(workItem);
        return;
      case 'close':
        // The issue goes with it; closing one already closed changes nothing.
        if (item.issue) {
          await this.#o.github.act('closeIssue', this.#o.repo, { number: item.issue, reason: 'not_planned' });
        }
        await this.#append(workItem, [
          {
            type: 'work-item.closed',
            actor: 'factory',
            summary: 'Closed unmerged, as Martin answered',
            payload: { outcome: 'no-change', reason: next.reason },
          },
        ]);
        return;
      case 'finish':
        await this.#o.steps.finish(workItem);
        this.#o.log.info({ workItem }, 'the work item is over');
        return;
    }
  }

  /** Runs one agent's step, and records what came of it. */
  async #step(item: QueueItem, agent: LineAgent, round: number, state: WorkItemState): Promise<void> {
    const { workItem } = item;
    const definition = this.#o.agents[agent];
    try {
      const attempt = await this.#queue.startStep(workItem);
      const prepared = await this.#prepare(item, agent, round, state);
      const outcome = await this.#o.steps.run({
        workItem,
        round,
        attempt,
        agent,
        repository: `https://github.com/${this.#o.repo}.git`,
        commit: prepared.commit,
        prompt: prepared.prompt,
        ...(definition.skill ? { skill: definition.skill } : {}),
        maxTurns: definition.maxTurns,
        deadlineSeconds: definition.deadlineSeconds,
        result: true,
        ...(prepared.resume ? { resume: prepared.resume } : {}),
      });
      if (outcome.kind === 'stopped') {
        this.#o.log.info({ workItem, agent, job: outcome.job }, 'a step stopped with the line; it runs again on start');
        return;
      }
      const calls = await stepCalls(this.#o.sql, outcome.job, agent, definition.maxTurns);
      const called: Draft[] = calls
        ? [{ type: 'model.called', actor: agent, summary: calledLine(agent, calls), payload: calls }]
        : [];
      let drafts: Draft[];
      try {
        if (outcome.kind === 'failed') throw new StepFailed(outcome.reason);
        const { handback } = outcome;
        const parsed = definition.result.safeParse(handback.result);
        if (!parsed.success) {
          const problems = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'result'}: ${i.message}`);
          throw new StepFailed(
            handback.result === undefined
              ? `The ${agent} handed back no result${handback.error ? ` (${handback.error})` : ''}`
              : `The ${agent}'s result does not fit its schema (${problems.join('; ')})`,
          );
        }
        drafts = await this.#effects(item, agent, round, state, prepared.commit, handback, parsed.data);
      } catch (error) {
        await this.#append(workItem, called);
        const reason = errorOf(error).message;
        await this.#queue.failed(workItem, reason);
        this.#o.log.warn({ workItem, agent, job: outcome.job, reason }, 'a step failed');
        return;
      }
      await this.#append(workItem, [...called, ...drafts]);
      await this.#queue.moved(workItem);
      this.#o.log.info({ workItem, agent, job: outcome.job, events: drafts.map((d) => d.type) }, 'a step is done');
    } finally {
      await this.#release(workItem);
    }
  }

  /** The commit a step starts from, its prompt, and the session it resumes. */
  async #prepare(
    item: QueueItem,
    agent: LineAgent,
    round: number,
    state: WorkItemState,
  ): Promise<{ commit: string; prompt: string; resume?: string | undefined }> {
    const { workItem } = item;
    const { agents, repo, github } = this.#o;
    const pullRequest = state.pullRequest;
    // Before a pull request, a step starts from main; after, from the pull request's head, and its diff is taken
    // against the pull request's base.
    const pr = pullRequest ? await github.read('pullRequest', repo, { number: pullRequest.number }) : undefined;
    const commit = pr ? pr.head.sha : await github.read('head', repo, { branch: 'main' });
    const base = pr?.base.sha ?? commit;
    const ticket = need(state.ticket, 'a ticket');
    switch (agent) {
      case 'planner':
        return { commit, prompt: agents.planner.prompt({ workItem, ticket, signals: await this.#signals(workItem) }) };
      case 'coder': {
        const spec = need(state.spec, 'a spec');
        const resume = round > 1 ? (item.session ?? undefined) : undefined;
        return { commit, prompt: agents.coder.prompt({ workItem, spec, round, returned: state.rebuild }), resume };
      }
      case 'reviewer':
        return {
          commit,
          prompt: agents.reviewer.prompt({
            workItem,
            spec: need(state.spec, 'a spec'),
            pullRequest: need(pullRequest, 'a pull request').number,
            base,
          }),
        };
      case 'describer':
        return {
          commit,
          prompt: agents.describer.prompt({
            workItem,
            ticket,
            spec: need(state.spec, 'a spec'),
            pullRequest: need(pullRequest, 'a pull request').number,
            base,
          }),
        };
    }
  }

  /** What an agent's result does, in GitHub and as events. Throws `StepFailed` for what counts against the step. */
  async #effects(
    item: QueueItem,
    agent: LineAgent,
    round: number,
    state: WorkItemState,
    commit: string,
    handback: Extract<StepOutcome, { kind: 'handed-back' }>['handback'],
    result: unknown,
  ): Promise<Draft[]> {
    const { workItem } = item;
    const { github, repo } = this.#o;
    switch (agent) {
      case 'planner': {
        const planned = result as import('./agents/planner.ts').PlannerResult;
        if (planned.verdict === 'spec') {
          const { spec } = planned;
          return [
            {
              type: 'spec.written',
              actor: 'planner',
              summary: `Spec written: ${count(spec.criteria.length, 'criterion', 'criteria')}, ${count(spec.scope.length, 'path')} in scope`,
              payload: spec,
            },
          ];
        }
        const hold: PayloadOf<'hold.started'> =
          planned.verdict === 'reject'
            ? { stage: 'plan', kind: 'held', cause: 'ticket-rejected', reason: planned.reason }
            : {
                stage: 'plan',
                kind: 'question',
                cause: 'question',
                reason: 'The planner needs an answer to write the spec',
                question: planned.question,
              };
        return [{ type: 'hold.started', actor: 'planner', summary: holdLine(hold), payload: hold }];
      }
      case 'coder': {
        const { title } = result as import('./agents/coder.ts').CoderResult;
        const spec = need(state.spec, 'a spec');
        if (!handback.patch) throw new StepFailed('The coder handed back no change');
        const fenced = fence(handback.patch, spec.scope);
        if (!fenced.ok) {
          const hold: PayloadOf<'hold.started'> = {
            stage: 'build',
            kind: 'held',
            cause: 'scope',
            reason: `The coder changed files outside the spec’s scope: ${fenced.outside.join(', ')}`.slice(0, 300),
          };
          return [{ type: 'hold.started', actor: 'factory', summary: holdLine(hold), payload: hold }];
        }
        const branch = state.pullRequest?.branch ?? branchFor(workItem, need(state.ticket, 'a ticket').title);
        if (!state.pullRequest) await github.act('setBranch', repo, { branch, sha: commit, force: true });
        const message = `${title}\n\n${handback.note}`.trim().slice(0, 9_000);
        await github.act<string>('applyPatch', repo, { branch, expectedHead: commit, patch: handback.patch, message });
        const number =
          state.pullRequest?.number ??
          (
            await github.act<{ number: number }>('openPullRequest', repo, {
              head: branch,
              base: 'main',
              title,
              body: pullRequestBody(workItem, item.issue, spec),
              draft: true,
            })
          ).number;
        await this.#queue.setSession(workItem, handback.session);
        const files = changedFiles(handback.patch);
        return [
          {
            type: 'pull-request.pushed',
            actor: 'coder',
            summary: `${round > 1 ? `Round ${round}` : 'A fix'} pushed to PR #${number}`,
            payload: {
              number,
              title,
              branch,
              attempt: round,
              testsFirst: files.some((f) => isTest(f.path)),
              files: files.slice(0, 200),
            },
          },
        ];
      }
      case 'reviewer': {
        const review = result as import('./agents/reviewer.ts').ReviewerResult;
        const number = need(state.pullRequest, 'a pull request').number;
        await github.act('review', repo, {
          number,
          commit,
          body: review.note,
          comments: review.findings.map((f) => ({
            path: f.path,
            line: f.line,
            body: `${f.blocking ? 'Blocking' : 'Suggestion'}${f.rule ? ` · rule ${f.rule}` : ''}: ${f.body}`,
          })),
        });
        return [
          {
            type: 'review.submitted',
            actor: 'reviewer',
            summary: `Review of PR #${number}: ${review.verdict.replace('-', ' ')}`,
            payload: {
              pullRequest: number,
              verdict: review.verdict,
              comments: review.findings.length,
              note: review.note,
            },
          },
        ];
      }
      case 'describer': {
        const described = result as import('./agents/describer.ts').DescriberResult;
        const number = need(state.pullRequest, 'a pull request').number;
        const pr = await github.read('pullRequest', repo, { number });
        await github.act('updatePullRequest', repo, {
          number,
          title: described.title,
          body: `${described.body}\n\n${refersTo(item.issue)}`.trim(),
        });
        if (pr.draft) await github.act('readyForReview', repo, { pullRequest: { number, url: '', nodeId: pr.nodeId } });
        return [
          { type: 'work-item.summarised', actor: 'describer', summary: 'Summary written', payload: described.summary },
        ];
      }
    }
  }

  /** Opens the ticket's issue in the app's repository, from the ticket's public view. */
  async #openIssue(workItem: string, state: WorkItemState): Promise<number> {
    const [row] = await this.#o.sql<{ public: { payload: PayloadOf<'ticket.opened'> } }[]>`
      select public from events where work_item = ${workItem} and type = 'ticket.opened' order by seq limit 1`;
    const ticket = row?.public.payload ?? need(state.ticket, 'a ticket');
    const where =
      'class' in ticket.fingerprint
        ? `\`${ticket.fingerprint.class}\` on \`${ticket.fingerprint.route}\``
        : `the words “${ticket.fingerprint.text}” on \`${ticket.fingerprint.page}\``;
    const body = [
      `The factory’s ticket #${workItem}: ${where}.`,
      '',
      `- Category: ${ticket.category}`,
      `- Severity: ${ticket.severity}`,
      ...(ticket.traces.length ? [`- Traces: ${ticket.traces.map((t) => `\`${t}\``).join(', ')}`] : []),
      '',
      'The factory is working on it: its fix will come as a pull request that refers here. The issue closes when the fix is verified in production.',
    ].join('\n');
    return this.#o.github.act<number>('openIssue', this.#o.repo, { title: ticket.title, body });
  }

  /**
   * Reads the pull request of every work item nobody is acting on, and appends what its gates and merge say that it
   * has not recorded. One with a step in hand is left until the step ends: a coder may have pushed its commit and not
   * yet recorded the push, and gates read on that commit first would be judged against the push before it.
   */
  async #readGates(): Promise<void> {
    const { github, repo, log } = this.#o;
    let required: string[] | undefined;
    for (const item of await this.#queue.free()) {
      try {
        const raw = await this.#raw(item.workItem);
        const state = fold(raw as LineEvent[]);
        if (!state.pullRequest) continue;
        const pr = await github.read('pullRequest', repo, { number: state.pullRequest.number });
        const runs = pr.state === 'open' ? await github.read('checkRuns', repo, { sha: pr.head.sha }) : [];
        required ??= await github.read('requiredChecks', repo, { branch: 'main' });
        const drafts = gateEvents(pr, runs, required, gateRecord(raw));
        if (drafts.length) await this.#append(item.workItem, drafts);
      } catch (error) {
        log.warn({ workItem: item.workItem, err: errorOf(error) }, 'could not read a pull request’s gates');
      }
    }
  }

  /** What each sense saw, by its typed fields only. */
  async #signals(workItem: string) {
    const rows = await this.#o.sql<{ payload: PayloadOf<'signal.received'> }[]>`
      select payload from events where work_item = ${workItem} and type = 'signal.received' order by seq`;
    return rows
      .filter(({ payload }) => payload.sense !== 'report')
      .map(({ payload: { sense, check, route, symptom } }) => ({ sense, check, route, symptom }));
  }

  async #raw(workItem: string): Promise<{ type: string; payload: unknown }[]> {
    const rows = await this.#o.sql<RawEvent[]>`
      select seq, type, version, payload from events where work_item = ${workItem} order by seq`;
    return rows.flatMap((row) => {
      const read = upcast({ ...row, seq: Number(row.seq) });
      return read.ok ? [{ type: read.event.type, payload: read.event.payload }] : [];
    });
  }

  async #events(workItem: string): Promise<LineEvent[]> {
    return (await this.#raw(workItem)) as LineEvent[];
  }

  async #append(workItem: string, drafts: Draft[]): Promise<void> {
    if (!drafts.length) return;
    const ts = this.#o.now().toISOString();
    await this.#o.events.append(drafts.map((draft) => asEvent(workItem, draft, ts)));
  }
}

const errorOf = (error: unknown) => ({
  type: (error as Error)?.name ?? 'Error',
  message: (error as Error)?.message ?? String(error),
});

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new StepFailed(`The work item has no ${what} yet`);
  return value;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const holdLine = (hold: PayloadOf<'hold.started'>) =>
  hold.kind === 'approval'
    ? 'Waiting for Martin to merge'
    : hold.kind === 'question'
      ? 'A question for Martin'
      : `Held for Martin at ${hold.stage}`;

const calledLine = (agent: LineAgent, calls: PayloadOf<'model.called'>) =>
  `${agent[0]?.toUpperCase()}${agent.slice(1)} called ${calls.model} ${count(calls.calls, 'time')}`;

/** A fix's branch: the factory's prefix, the work item, and a few words of its ticket's title. */
export function branchFor(workItem: string, title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 5)
    .join('-')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `factory/${workItem}${words ? `-${words}` : ''}`;
}

const refersTo = (issue: number | null) => (issue ? `Refers to #${issue}.` : '');

function pullRequestBody(workItem: string, issue: number | null, spec: PayloadOf<'spec.written'>): string {
  return [
    `The factory’s fix for ticket #${workItem}. ${refersTo(issue)}`.trim(),
    '',
    spec.outcome,
    '',
    ...spec.criteria.map((c) => `- Given ${c.given}, when ${c.when}, then ${c.expect}.`),
  ].join('\n');
}

/** Whether a path is a test, by the conventions Vitest and Jest find tests by. */
const isTest = (path: string) =>
  /(^|\/)(test|tests|__tests__)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);

/** Each file a patch changes, with the lines it adds and removes. */
export function changedFiles(patch: string): { path: string; added: number; removed: number }[] {
  return filesIn(patch).map(({ path, patch: file }) => {
    const lines = file.hunks.flatMap((hunk) => hunk.lines);
    return {
      path: path.slice(0, 200),
      added: lines.filter((l) => l.startsWith('+')).length,
      removed: lines.filter((l) => l.startsWith('-')).length,
    };
  });
}
