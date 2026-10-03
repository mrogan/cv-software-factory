/**
 * The inbox: where the senses leave what they found, for triage to take (0002_store-kind-work-items-and-inbox.sql).
 * A signal here is what `signal.received` will say if triage makes an event of it, with its artifacts beside it.
 */
import type { InboxSignal } from '@software-factory/events';
import { validateSignal } from '@software-factory/events/schemas';
import type { JSONValue, Sql } from 'postgres';

/** What a sense found, as triage matches it: the route and the symptom class. A report has none. */
export function fingerprintOf(found: Pick<InboxSignal, 'sense' | 'route' | 'symptom'>): string | null {
  if (found.sense === 'report') return null;
  if (!found.symptom) throw new Error(`A signal from the ${found.sense} needs the symptom class it saw`);
  return `${found.route} ${found.symptom}`;
}

/** Leaves a signal in the inbox, and returns its id. Triage hears of it at once, through NOTIFY. */
export async function sendSignal(sql: Sql, found: InboxSignal, id: string = crypto.randomUUID()): Promise<string> {
  const checked = validateSignal(found);
  if (!checked.ok) throw new Error(`The inbox refuses this signal:\n  ${checked.problems.join('\n  ')}`);
  await sql`insert into inbox (id, sense, fingerprint, signal)
            values (${id}, ${found.sense}, ${fingerprintOf(found)}, ${sql.json(found as unknown as JSONValue)})`;
  return id;
}
