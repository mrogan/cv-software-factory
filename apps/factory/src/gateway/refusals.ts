/**
 * The gateway's record of what it refuses, as `action.refused` with mechanism `gateway`: a spend cap reached (a day's,
 * a month's, a work item's, or a provider's the gateway holds), an agent or a model its policy does not allow, and any
 * agent's call while the line is stopped. A request it cannot read (a body it does not take, a beta it does not know)
 * is not a guardrail refusing anything, and is not recorded; nor is a replay with no cassette.
 *
 * Each refusal's output is the gateway's own words, as its answer gives them. Repeats fold, through the log every
 * worker that records refusals keeps (`../refusal-log.ts`): the first of a kind is appended at once, and the rest of its
 * minute as one event with how many, soon after its minute ends and as the gateway stops. Refusals of one cause fold apart from
 * another's, so a fold's words and guardrails are its own.
 *
 * Appends run one at a time behind the answer, never before it: a store that cannot take one is logged, and the
 * gateway answers as it would have.
 */
import { cutTo } from '@software-factory/events';
import type { EventWriter } from '@software-factory/store';
import { guardrailsFor, type RefusalCause } from '../../../../policy/refusals.ts';
import type { Logger } from '../log.ts';
import { RefusalLog } from '../refusal-log.ts';

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
  readonly #log: RefusalLog<GatewayCause>;

  constructor({ events, log, clock, foldMs }: RefusalsOptions) {
    this.#log = new RefusalLog<GatewayCause>({
      events,
      log,
      what: 'the gateway’s refusal',
      summary: (cause, { payload }) =>
        (payload.count ?? 1) > 1 ? `${SUMMARIES[cause]}, ${payload.count} times in a minute` : SUMMARIES[cause],
      ...(clock && { clock }),
      ...(foldMs !== undefined && { foldMs }),
    });
  }

  /** Takes one refusal, and appends it, or holds it as a repeat to fold. Never throws, and never waits on the store. */
  refused({ workItem, cause, action, output, at }: GatewayRefusal): void {
    this.#log.refused(cause, {
      workItem,
      at,
      payload: {
        mechanism: 'gateway',
        action: cutTo(action, 200),
        output: cutTo(output, 4000),
        guardrails: guardrailsFor('gateway', cause),
      },
    });
  }

  /** Appends the repeats whose minute has passed. */
  flush(now?: Date): Promise<void> {
    return this.#log.flush(now);
  }

  /** Appends what is due, looking often enough that a fold waits little past its minute, whenever its minute began. */
  start(everyMs?: number): void {
    this.#log.start(everyMs);
  }

  /** Appends every repeat still held, whatever the time, and waits for the appends: for the gateway stopping. */
  stop(): Promise<void> {
    return this.#log.stop();
  }

  /** Once every append asked for so far has been tried. */
  settled(): Promise<void> {
    return this.#log.settled();
  }
}
