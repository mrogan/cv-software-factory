/**
 * Caps the factory does not own. When a provider refuses because the account's credit is spent, the workspace's
 * spend limit is reached, or (for the local model) nothing is listening, the gateway treats it as a cap: it does not
 * retry, it appends `spend.capped` naming the provider, and every agent call to that provider waits. A few minutes
 * apart it asks the provider one small question, and the first answer appends `spend.cleared`.
 *
 * Which providers are capped is read from the store at start, so a restart neither repeats nor forgets.
 */
import type { NewEvent, ProviderCap } from '@software-factory/events';
import type { EventWriter } from '@software-factory/store';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import type { ProviderName, ProviderRefusal } from './providers.ts';

export interface Held {
  reason: ProviderCap;
  message: string;
}

export interface ProviderCapsOptions {
  sql: Sql;
  events: EventWriter;
  log: Logger;
  /** Asks a provider one small question; true if it answered. */
  probe: (provider: ProviderName) => Promise<boolean>;
  clock?: () => Date;
}

export class ProviderCaps {
  readonly #held = new Map<ProviderName, Held>();
  readonly #options: ProviderCapsOptions;
  #queue: Promise<void> = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;

  constructor(options: ProviderCapsOptions) {
    this.#options = options;
  }

  /** Why a provider refuses, while it does. */
  heldFor(provider: ProviderName): Held | undefined {
    return this.#held.get(provider);
  }

  get held(): Record<string, Held> {
    return Object.fromEntries(this.#held);
  }

  /** A provider refused for a cap: the line hears of it once. */
  cap(provider: ProviderName, refusal: ProviderRefusal): Promise<void> {
    return this.#serially(async () => {
      if (this.#held.has(provider)) return;
      await this.#append({
        type: 'spend.capped',
        summary: `${provider === 'local' ? 'The local model' : 'Anthropic'} refuses model calls (${refusal.reason}); agent calls wait`,
        payload: { cap: 'provider', provider, reason: refusal.reason, message: refusal.message },
      });
      this.#held.set(provider, refusal);
      this.#options.log.warn({ provider, reason: refusal.reason, message: refusal.message }, 'provider capped');
    });
  }

  /** A provider answered: if it was capped, the line hears it is not any more. */
  clear(provider: ProviderName): Promise<void> {
    if (!this.#held.has(provider)) return Promise.resolve();
    return this.#serially(async () => {
      if (!this.#held.has(provider)) return;
      await this.#append({
        type: 'spend.cleared',
        summary: `${provider === 'local' ? 'The local model' : 'Anthropic'} answers again; agent calls resume`,
        payload: { cap: 'provider', provider },
      });
      this.#held.delete(provider);
      this.#options.log.info({ provider }, 'provider cap cleared');
    });
  }

  /** Asks each capped provider once. */
  async probe(): Promise<void> {
    for (const provider of [...this.#held.keys()]) {
      try {
        if (await this.#options.probe(provider)) await this.clear(provider);
      } catch (error) {
        this.#options.log.warn({ provider, err: { message: (error as Error).message } }, 'provider probe failed');
      }
    }
  }

  async resume(): Promise<void> {
    const rows = await this.#options.sql<{ provider: ProviderName; type: string; payload: Held }[]>`
      select distinct on (payload->>'provider') payload->>'provider' as provider, type, payload
      from events where type in ('spend.capped', 'spend.cleared') and payload->>'cap' = 'provider'
      order by payload->>'provider', seq desc`;
    this.#held.clear();
    for (const row of rows) {
      if (row.type === 'spend.capped')
        this.#held.set(row.provider, { reason: row.payload.reason, message: row.payload.message });
    }
  }

  /** Asks the capped providers every few minutes. */
  start(everyMs = 3 * 60_000): void {
    this.#timer = setInterval(() => void this.probe(), everyMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer);
    await this.#queue;
  }

  #serially(step: () => Promise<void>): Promise<void> {
    this.#queue = this.#queue.then(step, step);
    return this.#queue;
  }

  async #append(event: Pick<NewEvent<'spend.capped' | 'spend.cleared'>, 'type' | 'summary' | 'payload'>) {
    await this.#options.events.append({
      id: crypto.randomUUID(),
      ts: (this.#options.clock?.() ?? new Date()).toISOString(),
      work_item: null,
      version: 2,
      actor: 'factory',
      artifacts: [],
      ...event,
    } as NewEvent);
  }
}
