/**
 * `factory line`: stopping and starting the line (guardrail 9: stop the line always works).
 *
 *     factory line stop [--reason <why>]
 *     factory line start [--autonomy supervised|guarded|lights-out]
 *
 * Every worker checks the line before it takes work, so a stopped line finishes what is in hand and takes nothing
 * new; signals wait in the inbox until it starts again. Connects with DATABASE_URL, or the PG* variables, as the
 * factory's writer.
 */
import { parseArgs } from 'node:util';
import { AUTONOMY, type Autonomy, type NewEvent, VERSIONS } from '@software-factory/events';
import { DiskArtifacts, EventWriter } from '@software-factory/store';
import postgres from 'postgres';

export const USAGE = `  factory line stop [--reason <why>]
  factory line start [--autonomy supervised|guarded|lights-out]`;

export async function run(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      reason: { type: 'string', default: 'Martin stopped the line' },
      autonomy: { type: 'string', default: 'supervised' },
    },
  });
  const [command] = positionals;
  const autonomy = values.autonomy as Autonomy;
  if ((command !== 'stop' && command !== 'start') || !AUTONOMY.includes(autonomy)) {
    console.log(`Usage:\n${USAGE}`);
    return 2;
  }
  const { DATABASE_URL } = process.env;
  const sql = DATABASE_URL ? postgres(DATABASE_URL, { onnotice: () => {} }) : postgres({ onnotice: () => {} });
  // Line events carry no artifacts, so the writer never looks in the artifact store.
  const writer = new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts('/nonexistent') });
  const event = (type: 'line.stopped' | 'line.started', summary: string, payload: object) =>
    ({
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      work_item: null,
      type,
      version: VERSIONS[type],
      actor: 'martin',
      summary,
      payload,
      artifacts: [],
    }) as NewEvent;
  try {
    if (command === 'stop') {
      await writer.append(event('line.stopped', `The line stopped: ${values.reason}`, { reason: values.reason }));
      console.log('The line is stopped. Workers finish what they hold and take nothing new.');
    } else {
      await writer.append(event('line.started', `The line started, ${autonomy}`, { autonomy }));
      console.log(`The line is running, ${autonomy}. Workers take what waited in the inbox.`);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  } finally {
    await sql.end();
  }
}
