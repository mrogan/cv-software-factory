/**
 * The line after triage: takes tickets into Plan and carries each work item through its agents' steps, the gates
 * and review, to Martin's merge. What to do next is decided from the work item's events (`machine.ts`); this module
 * does it, and appends what happened.
 *
 * - A step runs in a runner (`Steps`), and its handback becomes events: the agent's result read through its schema,
 *   what the result does in GitHub (both in the agent's module, `agents/`), and one `model.called` with the step's
 *   calls. A step that hands back nothing, ends unfinished, or hands back a result its schema refuses, has failed;
 *   the step runs again, as a new job, up to a limit.
 * - Only that counts against a step. When GitHub or the store fails while a handback's effects are done, the handback
 *   is kept (`Queue.keep`) and its effects are tried again later, without running the agent again; each write is
 *   recorded as it is begun and done, so none is done twice. After `LIMITS.effects` tries the work item holds.
 * - At most one step at a time in each of Plan, Build and Review, and a ticket comes onto the line only when nothing
 *   is in Plan or waiting for Build (`queue.ts`). Each work item is leased while it is acted on.
 * - It reads its pull requests' gates and merges through the GitHub worker about once a minute (`gates.ts`).
 * - When the line stops, it stops every step in hand, wherever it is, and takes nothing new; their work is lost and
 *   nothing of it is recorded, so starting again runs those steps afresh from the last event.
 * - When a work item ends, merged or closed, its runners' volume is deleted.
 *
 * It acts in GitHub only through the GitHub worker, and every agent's model through the gateway: it holds no key.
 */
import { hostname } from 'node:os';
import type { PayloadOf, RawEvent } from '@software-factory/events';
import { upcast } from '@software-factory/events';
import type { EventWriter } from '@software-factory/store';
import { lineStopped } from '@software-factory/triage';
import type { Logger } from 'pino';
import type { JSONValue, Sql } from 'postgres';
import type { ActionArgs, ActionName, ActionResult, ReadArgs, ReadName, ReadResult } from '../github/server.ts';
import type { StepOutcome, StepRequest } from '../runners/steps.ts';
import {
  count,
  type EffectsContext,
  holdDraft,
  need,
  type StepContext,
  StepFailed,
  StepStale,
} from './agents/agent.ts';
import type { Signal } from './agents/evidence.ts';
import { AGENTS, type Agents } from './agents/index.ts';
import { asEvent, type Draft, gateEvents, gateRecord } from './gates.ts';
import {
  decide,
  fold,
  LIMITS,
  type LineAgent,
  type LineEvent,
  type Next,
  STAGE_OF,
  type WorkItemState,
} from './machine.ts';
import { stepCalls } from './model-calls.ts';
import { type Pending, Queue, type QueueItem } from './queue.ts';

/** The runners, as the line uses them (`runners/steps.ts`). */
export interface Steps {
  run(request: StepRequest): Promise<StepOutcome>;
  finish(workItem: string): Promise<void>;
  cancel(): Promise<void>;
}

/** The GitHub worker, as the line uses it (`github/worker-client.ts`). */
export interface GitHubPort {
  act<K extends ActionName>(action: K, repo: string, args: ActionArgs[K]): Promise<ActionResult<K>>;
  read<K extends ReadName>(read: K, repo: string, args: ReadArgs[K]): Promise<ReadResult<K>>;
}

export interface LineOptions {
  /** As the factory's writer. */
  sql: Sql;
  events: Pick<EventWriter, 'append'>;
  steps: Steps;
  github: GitHubPort;
  log: Logger;
  /** The app's repository, as `owner/name`. */
  repo?: string;
  agents?: Agents;
  /** Who this worker is, as its leases name it: by default its host, which in the cluster is its pod. */
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

/** How long a work item stays leased for an action that is not a step. */
const ACTION_LEASE_SECONDS = 300;
/** A step's lease: its deadline, ten minutes to prepare, and some to spare. */
const leaseFor = (deadlineSeconds: number) => deadlineSeconds + 900;
/** The lease for a handback's effects, renewed before them: a few writes in GitHub, each up to two minutes. */
const EFFECTS_LEASE_SECONDS = 900;
/** How long the line waits before trying a handback's effects again: doubling from 30 seconds, to 10 minutes. */
const retryAfterMs = (tries: number) => Math.min(30_000 * 2 ** (tries - 1), 600_000);

export class Line {
  readonly #o: Required<Omit<LineOptions, 'me'>>;
  readonly #queue: Queue;
  /** The steps in hand, by work item, with the stage each holds. */
  readonly #inFlight = new Map<string, { stage: 'plan' | 'build' | 'review'; done: Promise<void> }>();
  #stopped = false;
  /** Aborted when the line stops, which stops every step started before, wherever it is. */
  #halt = new AbortController();
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
    this.#queue = new Queue(options.sql, options.me ?? `line-${hostname()}`);
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
        // A step still preparing has no Jobs yet: the signal stops it before it makes them.
        this.#halt.abort();
        await this.#o.steps.cancel();
      }
      return;
    }
    if (this.#stopped) {
      this.#o.log.info('the line started again: carrying on from the last events');
      this.#halt = new AbortController();
    }
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
        this.#halt.abort();
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
      const { events, last } = await this.#events(item.workItem);
      const { stage, next } = decide(events, item);
      // A kept handback is for the step the work item still needs, with nothing appended since; any other is over.
      const pending = item.effects;
      const kept =
        next.do === 'step' && pending?.agent === next.agent && pending.round === next.round && pending.since === last;
      if (pending && !kept) {
        await this.#queue.drop(item.workItem);
        item = { ...item, effects: null };
      }
      if (next.do === 'wait') {
        if (stage !== item.stage && (await this.#queue.claim(item.workItem, ACTION_LEASE_SECONDS))) {
          await this.#queue.release(item.workItem, stage);
        }
        return;
      }
      if (next.do === 'step') {
        // One step at a time in each of Plan, Build and Review.
        if ([...this.#inFlight.values()].some((s) => s.stage === STAGE_OF[next.agent])) return;
        if (kept && pending?.retryAt && Date.parse(pending.retryAt) > this.#o.now().getTime()) return;
        const seconds = kept ? EFFECTS_LEASE_SECONDS : leaseFor(this.#o.agents[next.agent].deadlineSeconds);
        const claimed = await this.#queue.claim(item.workItem, seconds);
        if (!claimed) return;
        await this.#queue.move(item.workItem, stage);
        const workItem = item.workItem;
        const state = fold(events);
        const done = (
          kept && claimed.effects
            ? this.#effects(claimed, state, claimed.effects).finally(() => this.#release(workItem))
            : this.#step(claimed, next.agent, next.round, state, last, this.#halt.signal)
        )
          .catch((error: unknown) =>
            this.#o.log.error({ workItem, err: errorOf(error) }, 'a step could not be recorded'),
          )
          .finally(() => this.#inFlight.delete(workItem));
        this.#inFlight.set(workItem, { stage: STAGE_OF[next.agent], done });
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
    const { stage } = decide((await this.#events(workItem)).events, item);
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
        await this.#append(workItem, [holdDraft('factory', next.hold)]);
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

  /** Runs one agent's step, and does what its handback says. `since` is the last event as the step starts. */
  async #step(
    item: QueueItem,
    agent: LineAgent,
    round: number,
    state: WorkItemState,
    since: number,
    signal: AbortSignal,
  ): Promise<void> {
    const { workItem } = item;
    const definition = this.#o.agents[agent];
    try {
      const attempt = await this.#queue.startStep(workItem);
      // Before a pull request, a step starts from main; after, from the pull request's head, and its diff is taken
      // against the pull request's base. A step that reads the change measures it from where the pull request's
      // branch left its base, as GitHub's diff does: main may have moved on since.
      const { github, repo } = this.#o;
      const number = state.pullRequest?.number;
      const pr = number ? await github.read('pullRequest', repo, { number }) : undefined;
      const commit = pr ? pr.head.sha : await github.read('head', repo, { branch: 'main' });
      const reads = pr && definition.readsChange;
      const base = reads
        ? (await github.read('comparison', repo, { base: pr.base.ref, head: commit })).mergeBase
        : (pr?.base.sha ?? commit);
      let started: Awaited<ReturnType<typeof definition.start>>;
      try {
        started = await definition.start(this.#context(item, round, state, commit, base));
      } catch (error) {
        if (!(error instanceof StepFailed)) throw error;
        return await this.#failed(workItem, agent, null, [], error.message);
      }
      const outcome = await this.#o.steps.run({
        workItem,
        round,
        attempt,
        agent,
        repository: `https://github.com/${repo}.git`,
        commit,
        ...(reads ? { base } : {}),
        prompt: started.prompt,
        ...(definition.skill ? { skill: definition.skill } : {}),
        maxTurns: definition.maxTurns,
        deadlineSeconds: definition.deadlineSeconds,
        result: true,
        ...(definition.resultFiles ? { resultFiles: definition.resultFiles } : {}),
        ...(started.resume ? { resume: started.resume } : {}),
        signal,
      });
      if (outcome.kind === 'stopped') {
        this.#o.log.info({ workItem, agent, job: outcome.job }, 'a step stopped with the line; it runs again on start');
        return;
      }
      const calls = await stepCalls(this.#o.sql, outcome.job, agent, definition.maxTurns);
      const called: Draft[] = calls
        ? [{ type: 'model.called', actor: agent, summary: calledLine(agent, calls), payload: calls }]
        : [];
      if (outcome.kind === 'failed') return await this.#failed(workItem, agent, outcome.job, called, outcome.reason);
      const { handback } = outcome;
      // A result written before the agent ran out of turns, or failed, is not one to act on.
      if (handback.ending !== 'finished') {
        const ended = handback.ending === 'max-turns' ? 'ran out of turns' : 'failed';
        const why = handback.error ? `: ${handback.error}` : '';
        return await this.#failed(workItem, agent, outcome.job, called, `The ${agent} ${ended}${why}`);
      }
      const pending: Pending = {
        agent,
        round,
        job: outcome.job,
        since,
        commit,
        base,
        handback,
        called,
        begun: [],
        done: {},
        tries: 0,
        failure: null,
        retryAt: null,
      };
      await this.#queue.keep(workItem, pending);
      await this.#effects(item, state, pending);
    } finally {
      await this.#release(workItem);
    }
  }

  /**
   * Does what a kept handback says, in GitHub and as events. A `StepFailed` counts against the step, and a
   * `StepStale` runs it again uncounted; anything else (GitHub or the store failing) keeps the handback for another
   * try, without the agent.
   */
  async #effects(item: QueueItem, state: WorkItemState, pending: Pending): Promise<void> {
    const { workItem } = item;
    const { agent } = pending;
    // The lease outlasts the writes, however long the agent took.
    await this.#queue.claim(workItem, EFFECTS_LEASE_SECONDS);
    let drafts: Draft[];
    try {
      const context = this.#effectsContext(item, state, pending);
      const started = await this.#o.agents[agent].start(context);
      drafts = await started.finish(pending.handback, context);
    } catch (error) {
      if (error instanceof StepFailed)
        return await this.#failed(workItem, agent, pending.job, pending.called, error.message);
      if (error instanceof StepStale) {
        await this.#append(workItem, pending.called);
        await this.#queue.drop(workItem);
        this.#o.log.info({ workItem, agent, job: pending.job, reason: error.message }, 'a step is out of date: again');
        return;
      }
      const reason = errorOf(error).message;
      const tries = pending.tries + 1;
      if (tries >= LIMITS.effects) {
        const hold = holdDraft('factory', {
          stage: STAGE_OF[agent],
          kind: 'held',
          cause: 'failures',
          reason: `The ${agent}'s work could not be put in GitHub ${tries} times: ${reason}`.slice(0, 300),
        });
        await this.#append(workItem, [...pending.called, hold]);
        await this.#queue.moved(workItem);
        this.#o.log.warn({ workItem, agent, job: pending.job, reason }, 'a step’s effects kept failing: held');
        return;
      }
      const retryAt = new Date(this.#o.now().getTime() + retryAfterMs(tries));
      await this.#queue.effectsFailed(workItem, reason, retryAt);
      this.#o.log.warn({ workItem, agent, job: pending.job, reason, tries }, 'a step’s effects failed: trying again');
      return;
    }
    await this.#append(workItem, [...pending.called, ...drafts]);
    await this.#queue.moved(workItem);
    this.#o.log.info({ workItem, agent, job: pending.job, events: drafts.map((d) => d.type) }, 'a step is done');
  }

  /** A failed attempt at a step: its calls are recorded, and it counts towards holding the work item. */
  async #failed(workItem: string, agent: LineAgent, job: string | null, called: Draft[], reason: string) {
    await this.#append(workItem, called);
    await this.#queue.failed(workItem, reason);
    this.#o.log.warn({ workItem, agent, job, reason }, 'a step failed');
  }

  #context(item: QueueItem, round: number, state: WorkItemState, commit: string, base: string): StepContext {
    const { workItem } = item;
    return {
      workItem,
      issue: item.issue,
      round,
      state,
      commit,
      base,
      session: item.session,
      failure: item.failure,
      ticket: () => this.#publicTicket(workItem, state),
      signals: () => this.#signals(workItem),
      read: (read, args) => this.#o.github.read(read, this.#o.repo, args),
    };
  }

  #effectsContext(item: QueueItem, state: WorkItemState, pending: Pending): EffectsContext {
    const { workItem } = item;
    const { github, repo } = this.#o;
    return {
      ...this.#context(item, pending.round, state, pending.commit, pending.base),
      once: async <T>(name: string, write: (again: boolean) => Promise<T>): Promise<T> => {
        // What a write gave back is kept as JSON, and given back as it was kept.
        if (Object.hasOwn(pending.done, name)) return pending.done[name] as T;
        const again = pending.begun.includes(name);
        if (!again) {
          await this.#queue.begun(workItem, name);
          pending.begun.push(name);
        }
        const result = await write(again);
        const kept = (result ?? null) as JSONValue;
        await this.#queue.done(workItem, name, kept);
        pending.done[name] = kept;
        return result;
      },
      act: (action, args) => github.act(action, repo, args),
      keepSession: (session) => this.#queue.setSession(workItem, session),
    };
  }

  /** Opens the ticket's issue in the app's repository, from the ticket's public view. */
  async #openIssue(workItem: string, state: WorkItemState): Promise<number> {
    const ticket = await this.#publicTicket(workItem, state);
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
    return this.#o.github.act('openIssue', this.#o.repo, { title: ticket.title, body });
  }

  /**
   * Reads the pull request of every work item nobody is acting on, and appends what its gates and merge say that it
   * has not recorded. One with a step in hand, or a handback whose effects are not done, is left until they are: a
   * coder may have pushed its commit and not yet recorded the push, and gates read on that commit first would be
   * judged against the push before it. The lease alone does not say so: it may run out while GitHub is slow.
   */
  async #readGates(): Promise<void> {
    const { github, repo, log } = this.#o;
    let required: string[] | undefined;
    for (const item of await this.#queue.free()) {
      if (this.#inFlight.has(item.workItem) || item.effects) continue;
      try {
        const { raw } = await this.#raw(item.workItem);
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

  /** The ticket as its public view has it: what anyone may read, and so what may reach GitHub or an agent. */
  async #publicTicket(workItem: string, state: WorkItemState): Promise<PayloadOf<'ticket.opened'>> {
    const [row] = await this.#o.sql<{ public: { payload: PayloadOf<'ticket.opened'> } }[]>`
      select public from events where work_item = ${workItem} and type = 'ticket.opened' order by seq limit 1`;
    return row?.public.payload ?? need(state.ticket, 'a ticket');
  }

  /** What each sense saw, from their public views. A visitor's report is left out whole, not only its text. */
  async #signals(workItem: string): Promise<Signal[]> {
    const rows = await this.#o.sql<{ public: { payload: PayloadOf<'signal.received'> } }[]>`
      select public from events where work_item = ${workItem} and type = 'signal.received' order by seq`;
    return rows
      .map((row) => row.public.payload)
      .filter((payload) => payload.sense !== 'report' && !payload.report)
      .map(({ report: _report, ...signal }) => signal);
  }

  /** A work item's events, upcast, and the last of them by its place in the store. */
  async #raw(workItem: string): Promise<{ raw: { type: string; payload: unknown }[]; last: number }> {
    const rows = await this.#o.sql<RawEvent[]>`
      select seq, type, version, payload from events where work_item = ${workItem} order by seq`;
    const raw = rows.flatMap((row) => {
      const read = upcast({ ...row, seq: Number(row.seq) });
      return read.ok ? [{ type: read.event.type, payload: read.event.payload }] : [];
    });
    return { raw, last: Number(rows.at(-1)?.seq ?? 0) };
  }

  async #events(workItem: string): Promise<{ events: LineEvent[]; last: number }> {
    const { raw, last } = await this.#raw(workItem);
    return { events: raw as LineEvent[], last };
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

const calledLine = (agent: LineAgent, calls: PayloadOf<'model.called'>) =>
  `${agent[0]?.toUpperCase()}${agent.slice(1)} called ${calls.model} ${count(calls.calls, 'time')}`;
