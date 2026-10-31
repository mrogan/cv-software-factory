/**
 * Appending refusals as `action.refused`, folded (`refusals.ts`): the gateway's own, and those the line relays (what
 * the GitHub worker and admission control refused). Each worker that records refusals keeps one.
 *
 * Refusals are folded within a group, which the worker names: two groups never fold into one event, so each group's
 * words and guardrails stay its own. The first of a kind is appended at once, and the rest of its minute as one event
 * with how many, each minute and as the worker stops.
 *
 * Appends run one at a time behind whatever was refused, never before it: a store that cannot take one is logged, and
 * the worker goes on as it would have.
 */
import { type NewEvent, VERSIONS } from '@software-factory/events';
import type { EventWriter } from '@software-factory/store';
import type { Logger } from './log.ts';
import { FOLD_MS, type FoldedRefusal, type Refusal, RefusalFolder } from './refusals.ts';

export interface RefusalLogOptions<G extends string> {
  events: Pick<EventWriter, 'append'>;
  log: Logger;
  /** Each event's summary, for its group and how many refusals it stands for. */
  summary: (group: G, refusal: FoldedRefusal) => string;
  /** What it records, for the log of an append that failed: "the gateway's refusal". */
  what: string;
  clock?: () => Date;
  /** How long repeats fold into one. */
  foldMs?: number;
}

export class RefusalLog<G extends string> {
  readonly #o: RefusalLogOptions<G>;
  readonly #folders = new Map<G, RefusalFolder>();
  #queue: Promise<void> = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;

  constructor(options: RefusalLogOptions<G>) {
    this.#o = options;
  }

  /** Takes one refusal, and appends it, or holds it as a repeat to fold. Never throws, and never waits on the store. */
  refused(group: G, refusal: Refusal): void {
    let folder = this.#folders.get(group);
    if (!folder) {
      folder = new RefusalFolder({ ms: this.#o.foldMs ?? FOLD_MS });
      this.#folders.set(group, folder);
    }
    this.#append(folder.add(refusal).map((folded) => [group, folded]));
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

  /** Appends every repeat still held, whatever the time, and waits for the appends: for the worker stopping. */
  async stop(): Promise<void> {
    clearInterval(this.#timer);
    this.#append(this.#each((folder) => folder.drain()));
    await this.#queue;
  }

  /** Once every append asked for so far has been tried. */
  settled(): Promise<void> {
    return this.#queue;
  }

  /** What each group's folder gives, oldest first, whatever its group. */
  #each(take: (folder: RefusalFolder) => FoldedRefusal[]): [G, FoldedRefusal][] {
    return [...this.#folders]
      .flatMap(([group, folder]) => take(folder).map((refusal): [G, FoldedRefusal] => [group, refusal]))
      .sort(([, a], [, b]) => a.at.getTime() - b.at.getTime());
  }

  #append(folded: [G, FoldedRefusal][]): void {
    for (const [group, refusal] of folded) {
      this.#queue = this.#queue
        .then(() => this.#o.events.append(this.#eventOf(group, refusal)))
        .then(
          () => undefined,
          (error: unknown) =>
            this.#o.log.error(
              { err: error, workItem: refusal.workItem, group, count: refusal.payload.count ?? 1 },
              `could not record ${this.#o.what}`,
            ),
        );
    }
  }

  #eventOf(group: G, refusal: FoldedRefusal): NewEvent<'action.refused'> {
    return {
      id: crypto.randomUUID(),
      ts: refusal.at.toISOString(),
      work_item: refusal.workItem,
      type: 'action.refused',
      version: VERSIONS['action.refused'],
      actor: 'factory',
      summary: this.#o.summary(group, refusal),
      payload: refusal.payload,
      artifacts: [],
    };
  }
}
