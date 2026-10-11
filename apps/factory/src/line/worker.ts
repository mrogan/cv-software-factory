/**
 * The line after triage: takes tickets into Plan and carries each work item through its agents' steps, the gates
 * and review, to Martin's merge, and on to Release and Verify. What to do next is decided from the work item's events
 * (`machine.ts`); this module does it, and appends what happened. A merged work item is held at Release until a
 * release carries it, and waits there while the release runs; a promoted one waits at Verify.
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
 * - About as often, it tells the app's deploy pull request which work items it carries: those whose fixes merged
 *   between the commit the shop runs and the one the pull request runs, as a release starting records them. It says
 *   so only when the list, or the pull request, has changed since it last did. Not with `only`: a soak of one work
 *   item says nothing of the others.
 * - About every thirty seconds, it reads the app's Rollout and its AnalysisRuns, and records each release on the work
 *   items it carries, or on the line when it carries none (`release.ts`). It changes nothing in Kubernetes. In a dry
 *   run, it answers for the releases of the dry run's merges, which never shipped.
 * - Once a release is promoted, it asks the sense that saw each work item's defect to look again (`verify.ts`), one
 *   look at a time for each work item, beside the steps. A look that cannot tell yet is tried again a few minutes
 *   later. A cleared signal closes the work item as verified, and its issue as completed with what cleared it; one
 *   that persists sends the work back to Plan, and the coder starts afresh, not from its old session.
 * - A verified work item whose ticket triage reopened, because its signal came back, comes back into Plan for a fresh
 *   pass once its issue is open again, with a comment saying what came back.
 * - With `only`, it acts on that one work item, taking its ticket onto the line if it is not there: it starts no
 *   step for any other, reads nothing for it and appends nothing, so a soak can take one ticket end to end. It still
 *   watches the app's releases, and records one that carries that work item or none.
 * - When the line stops, it stops every step in hand, wherever it is, and takes nothing new; their work is lost and
 *   nothing of it is recorded, so starting again runs those steps afresh from the last event.
 * - A work item's runners' volume is deleted when it merges, as nothing after a merge needs it (a return to Plan
 *   starts afresh from main), so the work items waiting at Release and Verify hold none of the runners' quota; and
 *   when it ends, closed, if it has one still.
 *
 * In a dry run, a pull request's head is a commit GitHub never had: the GitHub worker says which real commit it went
 * on and what the dry run's commits were, and the runner makes them before the step starts.
 *
 * It acts in GitHub only through the GitHub worker, and every agent's model through the gateway: it holds no key.
 */
import { hostname } from 'node:os';
import type { Evidence, PayloadOf, RawEvent, SignalSource } from '@software-factory/events';
import { returnWords, upcast } from '@software-factory/events';
import { type EventWriter, sendSignal } from '@software-factory/store';
import { lineStopped, uuidFrom } from '@software-factory/triage';
import type { Logger } from 'pino';
import type { JSONValue, Sql } from 'postgres';
import { release as RELEASE } from '../../../../policy/release.ts';
import { type Carry, DEPLOYS, MAX_CARRIES } from '../github/deploys.ts';
import type { ActionArgs, ActionName, ActionResult, ReadArgs, ReadName, ReadResult } from '../github/server.ts';
import { GitHubWorkerError } from '../github/worker-client.ts';
import type { PictureIndex } from '../pictures/index.ts';
import type { StepOutcome, StepRequest } from '../runners/steps.ts';
import {
  type Bounds,
  boundsOn,
  count,
  type EffectsContext,
  holdDraft,
  need,
  type StepContext,
  StepFailed,
  StepStale,
  stepFrom,
} from './agents/agent.ts';
import type { Signal } from './agents/evidence.ts';
import { AGENTS, type Agents } from './agents/index.ts';
import { capOn, capsInForce, lastSeq } from './caps.ts';
import { asEvent, type Draft, gateEvents, gateRecord } from './gates.ts';
import {
  decide,
  type Facts,
  fold,
  LIMITS,
  type LineAgent,
  type LineEvent,
  type Next,
  STAGE_OF,
  type WorkItemState,
} from './machine.ts';
import { stepCalls, workItemSpend } from './model-calls.ts';
import { pagesFor } from './pictures.ts';
import { type Pending, Queue, type QueueItem } from './queue.ts';
import { carried, Releases, type ReleaseWatchOptions } from './release.ts';
import {
  closingComment,
  type FirstSignal,
  type Look,
  look,
  reopeningComment,
  type Target,
  type VerifyClients,
  whatCleared,
} from './verify.ts';

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
  /** How often the line looks at the app's deploy pull request, to say what it carries. */
  deployEveryMs?: number;
  /** The app's Rollout, and Prometheus, for the line's watch of its releases; null, as by default, watches none. */
  release?: ReleaseWatchOptions | null;
  /** How often the line reads the app's release. */
  releaseEveryMs?: number;
  /**
   * Whether the line runs a dry run (LINE_MODE=dry-run): then it answers for the release of each merge the dry run
   * made, which never shipped, by its own word.
   */
  dryRun?: boolean;
  /** How long a dry run's release takes over each move: to start after the merge, each step, and its promotion. */
  dryRunReleaseMs?: number;
  /** Where Verify looks: the probes worker, Prometheus and Loki. A sense with none waits at Verify. */
  verify?: VerifyClients;
  /**
   * The index of the pictures the probes worker took while each canary ran (`pictures/`), for the pages a verification
   * compares with the version before; null, as by default, compares none. The line's event writer must know the
   * pictures' artifacts (`IndexedArtifacts`).
   */
  pictures?: Pick<PictureIndex, 'of' | 'lookOf'> | null;
  /** How long the line waits to look again when a sense could not tell (`policy/release.ts`'s `verify`). */
  verifyEveryMs?: number;
  /** How long after the promotion a sense may go on not telling before the work item holds for Martin. */
  verifyWaitMs?: number;
  /**
   * False for a line that takes no work and only stops the steps in hand (the step API's) when the line stops.
   */
  takesWork?: boolean;
  /**
   * The most one work item may spend on models: the gateway's cap, from the same profile (policy/spend.ts). Null, as
   * by default, holds nothing for spend: the gateway still refuses the calls, and the step fails.
   */
  workItemLimitUsd?: number | null;
  /**
   * Where each agent's calls go, as `policy/models.ts` decides for the gateway's profile: a step on a local model has
   * longer bounds (`boundsOn`). By default, a provider that is not local.
   */
  providerOf?: (agent: LineAgent) => 'anthropic' | 'bedrock' | 'local';
  /** The one work item the line acts on, leaving every other as it is; null, as by default, for them all. */
  only?: string | null;
  /**
   * How many work items the line takes in all, counting every one it has taken, before it takes no more; null, as by
   * default, for no limit. Those already on it go on to their end.
   */
  take?: number | null;
}

export const APP_REPOSITORY = 'mrogan/cv-worlds-worst-website';

/** What GitHub says of an issue that is gone (deleted or moved) or that the App may not change: asking again won't help. */
const ISSUE_GONE = [403, 404, 410];

/** How long a work item stays leased for an action that is not a step. */
const ACTION_LEASE_SECONDS = 300;
/** A step's lease: its deadline, ten minutes to prepare, and some to spare. */
const leaseFor = (deadlineSeconds: number) => deadlineSeconds + 900;
/** The lease for a handback's effects, renewed before them: a few writes in GitHub, each up to two minutes. */
const EFFECTS_LEASE_SECONDS = 900;
/** The lease for a look at Verify: the probes' half hour for a crawl run up to four times, and some to spare. */
const VERIFY_LEASE_SECONDS = 2700;
/** How long the line waits before trying a handback's effects again: doubling from 30 seconds, to 10 minutes. */
const retryAfterMs = (tries: number) => Math.min(30_000 * 2 ** (tries - 1), 600_000);

export class Line {
  readonly #o: Required<Omit<LineOptions, 'me'>>;
  readonly #queue: Queue;
  readonly #releases: Releases;
  /** The steps in hand, by work item, with the stage each holds. */
  readonly #inFlight = new Map<string, { stage: 'plan' | 'build' | 'review' | 'verify'; done: Promise<void> }>();
  /** When each work item at Verify whose last look could not tell may be looked at again. */
  readonly #lookAgainAt = new Map<string, number>();
  #stopped = false;
  /** Aborted when the line stops, which stops every step started before, wherever it is. */
  #halt = new AbortController();
  #gatesReadAt = Number.NEGATIVE_INFINITY;
  /** The merged work items whose volume this worker has deleted, until a step makes one again. */
  readonly #volumeGone = new Set<string>();
  #deployReadAt = Number.NEGATIVE_INFINITY;
  #releaseReadAt = Number.NEGATIVE_INFINITY;
  /** What the deploy pull request was last told it carries, with its number and commit; unknown after a start. */
  #described: string | undefined;

  constructor(options: LineOptions) {
    this.#o = {
      repo: APP_REPOSITORY,
      agents: AGENTS,
      now: () => new Date(),
      gatesEveryMs: 60_000,
      deployEveryMs: 60_000,
      release: null,
      releaseEveryMs: 30_000,
      dryRun: false,
      dryRunReleaseMs: 60_000,
      verify: {},
      pictures: null,
      verifyEveryMs: RELEASE.verify.everyMinutes * 60_000,
      verifyWaitMs: RELEASE.verify.waitHours * 60 * 60_000,
      takesWork: true,
      workItemLimitUsd: null,
      providerOf: () => 'anthropic',
      only: null,
      take: null,
      ...options,
    };
    this.#queue = new Queue(options.sql, options.me ?? `line-${hostname()}`, {
      only: this.#o.only,
      take: this.#o.take,
    });
    this.#releases = new Releases({
      sql: this.#o.sql,
      events: this.#o.events,
      github: this.#o.github,
      repo: this.#o.repo,
      log: this.#o.log,
      now: this.#o.now,
      watch: this.#o.release,
      dryRun: this.#o.dryRun,
      dryRunEveryMs: this.#o.dryRunReleaseMs,
      only: this.#o.only,
    });
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
    if (this.#o.only === null && this.#o.now().getTime() - this.#deployReadAt >= this.#o.deployEveryMs) {
      this.#deployReadAt = this.#o.now().getTime();
      await this.#describeDeploy().catch((error: unknown) =>
        this.#o.log.warn({ err: errorOf(error) }, 'could not say what the deploy pull request carries'),
      );
    }
    if (this.#o.now().getTime() - this.#releaseReadAt >= this.#o.releaseEveryMs) {
      this.#releaseReadAt = this.#o.now().getTime();
      await this.#releases.pass();
    }
    await this.#reopen();
    const taken = await this.#queue.admit();
    if (taken) this.#o.log.info({ workItem: taken }, 'a ticket came onto the line');
    for (const item of await this.#queue.free()) {
      if (this.#inFlight.has(item.workItem)) continue;
      await this.#advance(item).catch((error: unknown) =>
        this.#o.log.error({ workItem: item.workItem, err: errorOf(error) }, 'could not move a work item on'),
      );
    }
  }

  /**
   * Takes each reopened work item back into Plan, once its issue is open again, saying what came back. One whose issue
   * GitHub cannot open for now stays where it is, and is tried again on the next pass. One whose issue is gone, or
   * that the App may no longer open, comes back without it, and the line opens a new one as it enters Plan.
   */
  async #reopen(): Promise<void> {
    for (const item of await this.#queue.reopened()) {
      const { workItem } = item;
      if (this.#inFlight.has(workItem)) continue;
      let forgetIssue = false;
      try {
        const reopened = fold((await this.#events(workItem)).events).reopened.at(-1);
        if (item.issue && reopened) {
          const comment = reopeningComment(reopened, workItem);
          await this.#o.github.act('reopenIssue', this.#o.repo, { number: item.issue, comment }).catch((error) => {
            if (!(error instanceof GitHubWorkerError && ISSUE_GONE.includes(error.status))) throw error;
            this.#o.log.warn({ workItem, issue: item.issue, err: errorOf(error) }, 'the issue cannot be reopened');
            forgetIssue = true;
          });
        }
        if (await this.#queue.revive(workItem, { forgetIssue })) {
          this.#o.log.info({ workItem, issue: item.issue }, 'a reopened work item came back onto the line');
        }
      } catch (error) {
        this.#o.log.warn({ workItem, err: errorOf(error) }, 'could not take a reopened work item back onto the line');
      }
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
      const { stage, next } = decide(events, await this.#facts(item));
      if (fold(events).merged) await this.#dropVolume(item.workItem);
      // A kept handback is for the step the work item still needs, with nothing appended since; any other is over.
      const pending = item.effects;
      const kept =
        next.do === 'step' && pending?.agent === next.agent && pending.round === next.round && pending.since === last;
      if (pending && !kept) {
        await this.#queue.drop(item.workItem);
        item = { ...item, effects: null };
      }
      if (next.do === 'wait' || (next.do === 'verify' && !this.#lookDue(item.workItem))) {
        if (stage !== item.stage && (await this.#queue.claim(item.workItem, ACTION_LEASE_SECONDS))) {
          await this.#queue.release(item.workItem, stage);
        }
        return;
      }
      if (next.do === 'verify') {
        const claimed = await this.#queue.claim(item.workItem, VERIFY_LEASE_SECONDS);
        if (!claimed) return;
        await this.#queue.move(item.workItem, stage);
        const workItem = item.workItem;
        const done = this.#look(workItem, next.release, this.#halt.signal)
          .catch((error: unknown) => {
            this.#lookAgainAt.set(workItem, this.#o.now().getTime() + this.#o.verifyEveryMs);
            this.#o.log.warn({ workItem, err: errorOf(error) }, 'Verify could not look: it looks again later');
          })
          .then(() => this.#release(workItem))
          .catch((error: unknown) =>
            this.#o.log.error({ workItem, err: errorOf(error) }, 'could not let go of a work item after a look'),
          )
          .finally(() => this.#inFlight.delete(workItem));
        this.#inFlight.set(workItem, { stage: 'verify', done });
        return;
      }
      if (next.do === 'step') {
        // One step at a time in each of Plan, Build and Review.
        if ([...this.#inFlight.values()].some((s) => s.stage === STAGE_OF[next.agent])) return;
        if (kept && pending?.retryAt && Date.parse(pending.retryAt) > this.#o.now().getTime()) return;
        // Behind a cap the gateway refuses every call, so a step would only fail: it waits for the cap to clear.
        if (!kept) {
          const cap = capOn(await capsInForce(this.#o.sql), this.#o.providerOf(next.agent));
          if (cap) {
            this.#o.log.debug({ workItem: item.workItem, agent: next.agent, cap: cap.reason }, 'a step waits at a cap');
            return;
          }
        }
        const seconds = kept ? EFFECTS_LEASE_SECONDS : leaseFor(this.#bounds(next.agent).deadlineSeconds);
        const claimed = await this.#queue.claim(item.workItem, seconds);
        if (!claimed) return;
        await this.#queue.move(item.workItem, stage);
        const workItem = item.workItem;
        this.#volumeGone.delete(workItem);
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
   * Deletes a merged work item's volume, once: a work item waiting for a release would otherwise hold a share of the
   * runners' quota (`deploy/base/runners/quota.yaml`) for as long as it waits. A failure is tried again next pass.
   */
  async #dropVolume(workItem: string): Promise<void> {
    if (this.#volumeGone.has(workItem)) return;
    try {
      await this.#o.steps.finish(workItem);
      this.#volumeGone.add(workItem);
    } catch (error) {
      this.#o.log.warn({ workItem, err: errorOf(error) }, 'could not delete a merged work item’s volume');
    }
  }

  /**
   * Lets go of a work item, at the stage its events now put it in. Never at its end: only finishing ends a work item,
   * once its volume has gone, so a work item that ended while a step was in hand is still taken up and finished.
   */
  async #release(workItem: string): Promise<void> {
    const item = await this.#queue.get(workItem);
    if (!item) return;
    const { stage } = decide((await this.#events(workItem)).events, await this.#facts(item));
    await this.#queue.release(workItem, stage === 'ended' ? item.stage : stage);
  }

  /** An action that is not a step: quick, and done before the next. */
  async #act(
    item: QueueItem,
    next: Exclude<Next, { do: 'step' | 'wait' | 'verify' }>,
    state: WorkItemState,
  ): Promise<void> {
    const { workItem } = item;
    switch (next.do) {
      case 'open-issue': {
        const issue = await this.#openIssue(workItem, state);
        await this.#queue.setIssue(workItem, issue);
        this.#o.log.info({ workItem, issue }, 'opened the ticket’s issue');
        return;
      }
      case 'return': {
        const { do: _, ...returned } = next;
        // Back to Plan, the pass starts afresh, and its coder's first round with it.
        const payload = next.to === 'plan' ? returned : { ...returned, round: state.round + 1 };
        await this.#append(workItem, [
          {
            type: 'work.returned',
            actor: next.from === 'review' ? 'reviewer' : 'factory',
            // The console draws the same words, from the payload, in the return's pill on the line.
            summary: `#${workItem} · ${'round' in payload ? `round ${payload.round}` : 'to Plan'} · ${returnWords(payload)}`,
            payload,
          },
        ]);
        await this.#queue.moved(workItem);
        // The coder of a fresh pass starts a session of its own: the old one worked on a change that has merged.
        if (next.to === 'plan') await this.#queue.setSession(workItem, null);
        return;
      }
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
            summary: next.merged ? 'Closed after its merge, as Martin answered' : 'Closed unmerged, as Martin answered',
            payload: { outcome: 'no-change', reason: next.reason },
          },
        ]);
        return;
      case 'verified': {
        // The issue first, with what cleared it: closing one already closed changes nothing, and says nothing again.
        const reason = whatCleared(next.verification, next.answer);
        if (item.issue) {
          await this.#o.github.act('closeIssue', this.#o.repo, {
            number: item.issue,
            reason: 'completed',
            comment: closingComment(next.verification, workItem, next.answer),
          });
        }
        await this.#append(workItem, [
          {
            type: 'work-item.closed',
            actor: 'factory',
            summary: next.verification?.dryRun ? 'Verified by the dry run’s word, and closed' : 'Verified, and closed',
            payload: { outcome: 'verified', reason: reason.slice(0, 200) },
          },
        ]);
        this.#lookAgainAt.delete(workItem);
        return;
      }
      case 'finish':
        await this.#o.steps.finish(workItem);
        this.#o.log.info({ workItem }, 'the work item is over');
        return;
    }
  }

  /** Whether a work item at Verify may be looked at: never twice at once, and not before a look that could not tell. */
  #lookDue(workItem: string): boolean {
    if (this.#inFlight.has(workItem)) return false;
    return (this.#lookAgainAt.get(workItem) ?? Number.NEGATIVE_INFINITY) <= this.#o.now().getTime();
  }

  /**
   * One look at Verify, by the sense of the ticket's first signal, at the version the stable Service runs. What it
   * found is appended, unless the line stopped meanwhile: a look is read-only, and the next start looks again.
   */
  async #look(workItem: string, promoted: PayloadOf<'release.promoted'>, signal: AbortSignal): Promise<void> {
    const target = await this.#target(workItem, promoted);
    const now = this.#o.now();
    const first = await this.#firstSignal(workItem);
    let found: Look;
    try {
      found = await look(first, target, {
        ...this.#o.verify,
        now,
        dryRun: this.#o.dryRun,
        signal,
      });
    } catch (error) {
      found = { kind: 'wait', why: `the sense could not be asked: ${errorOf(error).message}` };
    }
    if (signal.aborted) return;
    // A release promoted while the sense looked: what it saw was of a version no longer stable. Look again at once.
    if (found.kind === 'finished' && !target.dryRun) {
      const stable = await this.#target(workItem, promoted);
      if (stable.version !== target.version) {
        this.#o.log.info({ workItem, looked: target.version, stable: stable.version }, 'a release came between');
        return;
      }
    }
    // Read only when something is appended: a look that cannot tell yet comes round every few minutes.
    const shown = () => this.#pictures(promoted, first);
    switch (found.kind) {
      case 'wait': {
        const hours = this.#o.verifyWaitMs / 3_600_000;
        if (now.getTime() - target.at.getTime() < this.#o.verifyWaitMs) {
          this.#lookAgainAt.set(workItem, now.getTime() + this.#o.verifyEveryMs);
          this.#o.log.info({ workItem, version: target.version, why: found.why }, 'Verify cannot tell yet');
          return;
        }
        // A sense that still cannot tell long after the release may never: Martin judges, told why.
        const reason = `Verify could not tell in ${hours} hours after the release: ${found.why}`.slice(0, 300);
        await this.#append(workItem, [
          {
            ...holdDraft('factory', { stage: 'verify', kind: 'held', cause: 'verify', reason }),
            artifacts: (await shown()).artifacts,
          },
        ]);
        await this.#queue.moved(workItem);
        return;
      }
      case 'hold':
        // Martin judges with the pictures before him: every page on the version before and on the fix's.
        await this.#append(workItem, [
          {
            ...holdDraft('factory', {
              stage: 'verify',
              kind: 'approval',
              cause: 'verify',
              reason: found.reason.slice(0, 300),
            }),
            artifacts: (await shown()).artifacts,
          },
        ]);
        await this.#queue.moved(workItem);
        return;
      case 'finished': {
        const { pages, artifacts } = await shown();
        const v = { ...found.verification, pages };
        const said = v.dryRun ? 'by the dry run’s word' : `by the ${v.sense ?? 'sense'}`;
        await this.#append(workItem, [
          {
            type: 'verification.finished',
            actor: v.sense && v.sense !== 'report' && !v.dryRun ? v.sense : 'factory',
            summary: `${v.outcome === 'cleared' ? 'Cleared' : 'Persists'} on ${v.version?.slice(0, 7)}, ${said}`,
            payload: v,
            artifacts,
          },
        ]);
        this.#lookAgainAt.delete(workItem);
        await this.#queue.moved(workItem);
        this.#o.log.info({ workItem, outcome: v.outcome, sense: v.sense, version: v.version }, 'verified a release');
        return;
      }
    }
  }

  /**
   * The release to verify a work item's fix on: the latest promoted since the one that carried it, which the stable
   * Service runs and which carries the fix too, or the dry run's own.
   */
  async #target(workItem: string, promoted: PayloadOf<'release.promoted'>): Promise<Target> {
    const { sql } = this.#o;
    const [own] = await sql<{ seq: string; ts: Date }[]>`
      select seq, ts from events
      where work_item = ${workItem} and type = 'release.promoted' and payload->>'release' = ${promoted.release}
      order by seq desc limit 1`;
    const base = { against: promoted.previous, dryRun: promoted.dryRun };
    if (!own) throw new Error(`Work item ${workItem} has no promotion of ${promoted.release}`);
    if (promoted.dryRun) return { ...base, version: promoted.version, at: new Date(own.ts) };
    const [latest] = await sql<{ version: string; ts: Date }[]>`
      select payload->>'version' as version, ts from events
      where type = 'release.promoted' and (payload->>'dryRun')::boolean is not true and seq >= ${own.seq}
      order by seq desc limit 1`;
    return { ...base, version: latest?.version ?? promoted.version, at: new Date(latest?.ts ?? own.ts) };
  }

  /**
   * The pages pictured while the release that carried the fix ran as a canary beside the version before, with the
   * ticket's own marked (`pictures.ts`). A dry run's release never ran, and has none.
   */
  async #pictures(promoted: PayloadOf<'release.promoted'>, first: FirstSignal | undefined) {
    const { pictures } = this.#o;
    if (!pictures || promoted.dryRun) return { pages: [], artifacts: [] };
    try {
      const taken = await pictures.of(promoted.version, promoted.previous);
      if (!taken.length) return { pages: [], artifacts: [] };
      const look = first && (await pictures.lookOf(first.sense, first.check, first.route));
      const shown = pagesFor(taken, { route: first?.route ?? '*', ...(look && { path: look.path }) });
      if (first && !shown.pages.some((p) => p.intended)) {
        this.#o.log.info({ release: promoted.release, route: first.route }, 'no page pictured is the ticket’s own');
      }
      return shown;
    } catch (error) {
      this.#o.log.warn({ release: promoted.release, err: errorOf(error) }, 'the release’s pictures could not be read');
      return { pages: [], artifacts: [] };
    }
  }

  /** The ticket's first signal: its sense, check, route and evidence, never a report's words. */
  async #firstSignal(workItem: string): Promise<FirstSignal | undefined> {
    const [row] = await this.#o.sql<
      { sense: SignalSource; check: string; route: string; evidence: Evidence[] | null }[]
    >`
      select payload->>'sense' as sense, payload->>'check' as check, payload->>'route' as route,
             payload->'evidence' as evidence
      from events where work_item = ${workItem} and type = 'signal.received' order by seq limit 1`;
    return row && { sense: row.sense, check: row.check, route: row.route, evidence: row.evidence ?? [] };
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
    const bounds = this.#bounds(agent);
    try {
      // A cap set after this, while the step runs, ends it without a result: that is the cap's, not the step's.
      const from = await lastSeq(this.#o.sql);
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
      // A pull request's head is checked out as GitHub has it; a dry run's, which GitHub never had, as the real
      // commit under it with the dry run's commits made on it in the runner.
      const checkout = pr ? await github.read('checkout', repo, { sha: commit }) : { commit, commits: [] };
      let started: Awaited<ReturnType<typeof definition.start>>;
      try {
        started = await definition.start(this.#context(item, round, state, commit, base));
      } catch (error) {
        if (!(error instanceof StepFailed)) throw error;
        return await this.#failed(workItem, agent, null, [], error.message);
      }
      const outcome = await this.#o.steps.run({
        ...stepFrom(
          { ...definition, maxTurns: bounds.maxTurns },
          {
            repository: repo,
            commit: checkout.commit,
            commits: checkout.commits,
            base: reads ? base : undefined,
            prompt: started.prompt,
            resume: started.resume,
          },
        ),
        workItem,
        round,
        attempt,
        deadlineSeconds: bounds.deadlineSeconds,
        signal,
      });
      if (outcome.kind === 'stopped') {
        this.#o.log.info({ workItem, agent, job: outcome.job }, 'a step stopped with the line; it runs again on start');
        return;
      }
      const calls = await stepCalls(this.#o.sql, outcome.job, agent, bounds.maxTurns);
      const called: Draft[] = calls
        ? [{ type: 'model.called', actor: agent, summary: calledLine(agent, calls), payload: calls }]
        : [];
      const unfinished =
        outcome.kind === 'failed' || outcome.handback.ending !== 'finished' || outcome.handback.error !== undefined;
      const cap = unfinished && capOn(await capsInForce(this.#o.sql, from), this.#o.providerOf(agent));
      if (cap) {
        await this.#append(workItem, called);
        this.#o.log.info(
          { workItem, agent, job: outcome.job, cap: cap.reason },
          'a step ended at a cap; it runs again when the cap clears',
        );
        return;
      }
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

  /** An agent's turns and deadline, on the model its calls go to. */
  #bounds(agent: LineAgent): Bounds {
    return boundsOn(this.#o.agents[agent], this.#o.providerOf(agent));
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
      // Its id is the same each time, and the inbox keeps the first: leaving it again does nothing.
      leaveSignal: async (key, signal) => {
        const observedAt = this.#o.now().toISOString();
        await sendSignal(this.#o.sql, { ...signal, observedAt }, signalId(workItem, key));
      },
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
        // Once merged, the pull request has nothing more to say: the release carries the work item on.
        if (!state.pullRequest || state.merged) continue;
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

  /**
   * Tells the app's open deploy pull request which work items it carries (`carried`): each whose latest fix merged
   * after the commit the shop runs (the last promoted release's, else the one pinned now), up to the one the pull
   * request runs. A dry run's merge commit, which GitHub never had, is in no range. The worker leaves a body that says
   * the same as it is; the line does not ask again until the list or the pull request changes.
   */
  async #describeDeploy(): Promise<void> {
    const { github, repo, log } = this.#o;
    const target = DEPLOYS.find((t) => t.repo === repo);
    if (!target) return;
    const proposal = await github.read('deployProposal', repo, { branch: target.branch });
    if (!proposal) return;
    // Without a commit to start from, or with one GitHub never had, there is no range to look in.
    const carries = await carried(this.#o, proposal.commit, proposal.pinned ?? undefined);
    if (!carries) return;
    // The latest merges by name, and the rest counted.
    const named: Carry[] = carries
      .slice(-MAX_CARRIES)
      .map((c) => ({ ...c, title: c.title ?? `Work item ${c.workItem}` }));
    const more = carries.length - named.length;
    const deploy = { number: proposal.number, commit: proposal.commit, carries: named, ...(more ? { more } : {}) };
    const said = JSON.stringify(deploy);
    if (said === this.#described) return;
    let changed: boolean;
    try {
      changed = await github.act('describeDeploy', repo, deploy);
    } catch (error) {
      // Merged or moved on since the watch last looked: its next pass says which pull request is open.
      if ((error as { status?: number }).status === 409) {
        log.debug({ number: proposal.number, commit: proposal.commit }, 'the deploy pull request moved on: later');
        return;
      }
      throw error;
    }
    this.#described = said;
    if (changed) {
      log.info(
        { number: proposal.number, commit: proposal.commit, carries: named.map((c) => c.workItem) },
        'said what the deploy pull request carries',
      );
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

  /** What the line knows of a work item beside its events: its row in the queue, and its spend against the cap. */
  async #facts(item: QueueItem): Promise<Facts> {
    const limitUsd = this.#o.workItemLimitUsd;
    if (limitUsd === null) return item;
    return { ...item, spend: { spentUsd: await workItemSpend(this.#o.sql, item.workItem), limitUsd } };
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

/** The inbox id of a signal the line leaves for a work item: the same key always gives the same id. */
export const signalId = (workItem: string, key: string) => uuidFrom(`line:${workItem}:${key}`);

const errorOf = (error: unknown) => ({
  type: (error as Error)?.name ?? 'Error',
  message: (error as Error)?.message ?? String(error),
});

const calledLine = (agent: LineAgent, calls: PayloadOf<'model.called'>) =>
  `${agent[0]?.toUpperCase()}${agent.slice(1)} called ${calls.model} ${count(calls.calls, 'time')}`;
