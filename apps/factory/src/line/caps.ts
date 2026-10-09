/**
 * The caps that make an agent's calls wait, from the store: the factory's own day and month caps, which refuse every
 * call, and a provider's cap the factory does not own (its credit spent, its workspace's limit reached, the local
 * model not running), which refuses the calls that go to it. The gateway appends `spend.capped` as one is reached and
 * `spend.cleared` as it is no longer, and refuses the calls in between: a step started then can only fail, and one
 * running as it is reached ends without a result. So the line starts no step behind a cap, and counts nothing
 * against a step that a cap ended; the `spend.cleared` that lifts it wakes the line, as any append does.
 */
import type { ModelProvider, PayloadOf } from '@software-factory/events';
import type { Sql } from 'postgres';

/** A cap in force, and the seq of the `spend.capped` that set it. */
export interface Cap {
  seq: number;
  /** The factory's own cap, or the provider that refuses. */
  cap: 'day' | 'month' | ModelProvider;
  /** What the cap is, in words for the log. */
  reason: string;
}

/** The key one cap is set and cleared under: a provider's name, or the factory's day or month. */
const keyOf = (payload: PayloadOf<'spend.capped'> | PayloadOf<'spend.cleared'>) =>
  payload.cap === 'provider' ? payload.provider : payload.cap;

/**
 * The caps in force, each as the last `spend.capped` that set it with no `spend.cleared` since; and, given `since`,
 * every cap set after it as well, cleared or not.
 */
export async function capsInForce(sql: Sql, since?: number): Promise<Cap[]> {
  const rows = await sql<{ seq: string; type: 'spend.capped' | 'spend.cleared'; payload: PayloadOf<'spend.capped'> }[]>`
    select seq, type, payload from events where type in ('spend.capped', 'spend.cleared') order by seq`;
  const held = new Map<Cap['cap'], Cap>();
  const set: Cap[] = [];
  for (const { seq, type, payload } of rows) {
    const key = keyOf(payload);
    if (type === 'spend.cleared') {
      held.delete(key);
      continue;
    }
    const cap: Cap = {
      seq: Number(seq),
      cap: key,
      reason:
        payload.cap === 'provider' ? `${payload.provider} refuses (${payload.reason})` : `the ${payload.cap}’s cap`,
    };
    held.set(key, cap);
    if (since !== undefined && cap.seq > since) set.push(cap);
  }
  return [...held.values(), ...set.filter((cap) => held.get(cap.cap) !== cap)];
}

/** The cap, if any, that refuses calls to `provider`: the factory's own refuse every call. */
export const capOn = (caps: Cap[], provider: ModelProvider): Cap | undefined =>
  caps.find((cap) => cap.cap === provider || cap.cap === 'day' || cap.cap === 'month');

/** The last seq in the store: a step that starts after it can tell a cap set while it ran from one set before. */
export async function lastSeq(sql: Sql): Promise<number> {
  const [row] = await sql<{ seq: string | null }[]>`select max(seq) as seq from events`;
  return Number(row?.seq ?? 0);
}
