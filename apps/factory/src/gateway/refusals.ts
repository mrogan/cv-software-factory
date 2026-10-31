/**
 * The gateway's record of what it refuses, as `action.refused` with mechanism `gateway`: a spend cap reached (a day's,
 * a month's, a work item's, or a provider's the gateway holds), an agent or a model its policy does not allow, and any
 * agent's call while the line is stopped. A request it cannot read (a body it does not take, a beta it does not know)
 * is not a guardrail refusing anything, and is not recorded; nor is a replay with no cassette.
 *
 * Each refusal's output is the gateway's own words, as its answer gives them. Repeats fold (`../refusals.ts`): the
 * first of a kind is appended at once, and the rest of its minute as one event with how many, each minute and as the
 * gateway stops. Refusals of one cause fold apart from another's, so a fold's words and guardrails are its own.
 *
 * Appends run one at a time behind the answer, never before it: a store that cannot take one is logged, and the
 * gateway answers as it would have.
 */
import { cutTo, type NewEvent, VERSIONS } from '@software-factory/events';
import type { EventWriter } from '@software-factory/store';
import { guardrailsFor, type RefusalCause } from '../../../../policy/refusals.ts';
import type { Logger } from '../log.ts';
import { FOLD_MS, type FoldedRefusal, RefusalFolder } from '../refusals.ts';

/** Why the gateway refused: a cap, its policy on agents and models, or the line stopped. */
export type GatewayCause = RefusalCause<'gateway'>;

export interface GatewayRefusal {
  /** The work item its job token names, or null for a call no job token names. */
  workItem: string | null;
  cause: GatewayCause;
  /** What was refused, the same for each repeat of it. */
  action: string;
  /** The gateway's own words, as its answer gives them. */
  output: string;
  at: Date;
}

const SUMMARIES: Record<GatewayCause, string> = {
  cap: 'The gateway refused a model call at a spend cap',
  policy: 'The gateway refused a model call its policy does not allow',
  stopped: 'The gateway refused a model call while the line is stopped',
};

export interface RefusalsOptions {
  events: Pick<EventWriter, 'append'>;
  log: Logger;
  clock?: () => Date;
  /** How long repeats fold into one. */
  foldMs?: number;
}

export class Refusals {
  readonly #o: RefusalsOptions;
  readonly #folders: Record<GatewayCause, RefusalFolder>;
  #queue: Promise<void> = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;

  constructor(options: RefusalsOptions) {
    this.#o = options;
    const ms = options.foldMs ?? FOLD_MS;
    this.#folders = {
      cap: new RefusalFolder({ ms }),
      policy: new RefusalFolder({ ms }),
      stopped: new RefusalFolder({ ms }),
    };
  }

  /** Takes one refusal, and appends it, or holds it as a repeat to fold. Never throws, and never waits on the store. */
  refused({ workItem, cause, action, output, at }: GatewayRefusal): void {
    const folded = this.#folders[cause].add({
      workItem,
      at,
      payload: {
        mechanism: 'gateway',
        action: cutTo(action, 200),
        output: cutTo(output, 4000),
        guardrails: guardrailsFor('gateway', cause),
      },
    });
    this.#append(folded.map((refusal) => [cause, refusal]));
  }

  /** Appends the repeats whose minute has passed. */
  flush(now: Date = this.#o.clock?.() ?? new Date()): Promise<void> {
    this.#append(this.#each((folder) => folder.due(now)));
    return this.#queue;
  }

  /** Appends what is due each minute. */
  start(everyMs = FOLD_MS): void {
    this.#timer = setInterval(() => void this.flush(), everyMs);
    this.#timer.unref();
  }

  /** Appends every repeat still held, whatever the time, and waits for the appends: for the gateway stopping. */
  async stop(): Promise<void> {
    clearInterval(this.#timer);
    this.#append(this.#each((folder) => folder.drain()));
    await this.#queue;
  }

  /** Once every append asked for so far has been tried. */
  settled(): Promise<void> {
    return this.#queue;
  }

  /** What each cause's folder gives, oldest first, whatever its cause. */
  #each(take: (folder: RefusalFolder) => FoldedRefusal[]): [GatewayCause, FoldedRefusal][] {
    return (Object.entries(this.#folders) as [GatewayCause, RefusalFolder][])
      .flatMap(([cause, folder]) => take(folder).map((refusal): [GatewayCause, FoldedRefusal] => [cause, refusal]))
      .sort(([, a], [, b]) => a.at.getTime() - b.at.getTime());
  }

  #append(folded: [GatewayCause, FoldedRefusal][]): void {
    for (const [cause, refusal] of folded) {
      this.#queue = this.#queue
        .then(() => this.#o.events.append(eventOf(cause, refusal)))
        .then(
          () => undefined,
          (error: unknown) =>
            this.#o.log.error(
              { err: error, workItem: refusal.workItem, cause, count: refusal.payload.count ?? 1 },
              'could not record the gateway’s refusal',
            ),
        );
    }
  }
}

function eventOf(cause: GatewayCause, { workItem, at, payload }: FoldedRefusal): NewEvent<'action.refused'> {
  const count = payload.count ?? 1;
  return {
    id: crypto.randomUUID(),
    ts: at.toISOString(),
    work_item: workItem,
    type: 'action.refused',
    version: VERSIONS['action.refused'],
    actor: 'factory',
    summary: count > 1 ? `${SUMMARIES[cause]}, ${count} times in a minute` : SUMMARIES[cause],
    payload,
    artifacts: [],
  };
}
