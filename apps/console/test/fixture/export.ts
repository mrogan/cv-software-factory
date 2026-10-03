/**
 * Writes the console's milestone 4 test data to its event log: log/events.ndjson, beside the screenshots in
 * log/artifacts. The console's tests read the log; nothing the console ships does.
 *
 *     node apps/console/test/fixture/export.ts
 *
 * Every event is validated as the store would validate it, and written as its public view, so the log holds
 * nothing a visitor may not see. A unit test fails when the log is out of date.
 */
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { PublicEvent } from '@software-factory/events';
import { EVENTS_FILE, writeLogEvents } from '@software-factory/events/log';
import { publicView } from '@software-factory/events/public';
import { validate } from '@software-factory/events/schemas';
import { ARTIFACTS, LOG } from './captures.ts';
import { fixtureEvents } from './items.ts';

export async function publicFixture(): Promise<PublicEvent[]> {
  const events = await fixtureEvents();
  const problems = events.flatMap((event) => {
    const result = validate(event);
    const missing = event.artifacts.filter((a) => !existsSync(join(ARTIFACTS, a.hash))).map((a) => `missing ${a.hash}`);
    return [...(result.ok ? [] : result.problems), ...missing].map((p) => `#${event.work_item} ${event.type}: ${p}`);
  });
  if (problems.length) throw new Error(`The test data is not valid:\n  ${problems.join('\n  ')}`);
  return events.map((event, i) => ({ ...event, ...publicView(event.type, event), seq: i + 1 }) as PublicEvent);
}

if (import.meta.main) {
  const events = await publicFixture();
  writeLogEvents(LOG, events);
  console.log(`wrote ${events.length} events to ${relative(process.cwd(), join(LOG, EVENTS_FILE))}`);
}
