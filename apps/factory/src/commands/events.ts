/**
 * `factory events`: moving event-log folders in and out of the store.
 *
 *     factory events load <log>  [--only 1296,1302] [--except 1302]
 *     factory events play <log>  [--speed 60] [--max-pause 5] [--only …] [--except …]
 *     factory events export <work item> <folder>
 *     factory events export --all <folder>
 *
 * `load` appends a log's events with their times moved so the last one is now. `play` appends them at their
 * recorded pace, sped up, so the console can be watched live. Both refuse a store that holds the other kind of
 * event: samples and real work never mix. `export` writes a work item's public events and artifacts to a log, or with `--all` every public event in the store.
 *
 * Connects with DATABASE_URL, or the PG* variables, as the factory's writer. Artifacts go in, and come out of,
 * ARTIFACTS_DIR.
 */
import { parseArgs } from 'node:util';
import { DiskArtifacts } from '@software-factory/store';
import postgres from 'postgres';
import { exportItem, load, play } from '../events.ts';

export const USAGE = `  factory events load <log> [--only <items>] [--except <items>]
  factory events play <log> [--speed <times>] [--max-pause <seconds>] [--only <items>] [--except <items>]
  factory events export <work item> <folder>
  factory events export --all <folder>`;

export async function run(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      only: { type: 'string' },
      except: { type: 'string' },
      speed: { type: 'string', default: '60' },
      'max-pause': { type: 'string', default: '5' },
      all: { type: 'boolean' },
    },
  });
  const [command, ...rest] = positionals;
  const list = (value: string | undefined) => value?.split(',').map((item) => item.trim().replace(/^#/, ''));
  const selection = { only: list(values.only), except: list(values.except) };
  const { DATABASE_URL, ARTIFACTS_DIR } = process.env;
  if (!ARTIFACTS_DIR) {
    console.error('Set ARTIFACTS_DIR to the artifact store’s folder.');
    return 2;
  }
  const sql = DATABASE_URL ? postgres(DATABASE_URL, { onnotice: () => {} }) : postgres({ onnotice: () => {} });
  const store = new DiskArtifacts(ARTIFACTS_DIR);

  try {
    if (command === 'load' && rest[0]) {
      const { events, artifacts } = await load(sql, store, rest[0], selection);
      console.log(`Loaded ${events} events and ${artifacts} artifacts, the last of them now.`);
    } else if (command === 'play' && rest[0]) {
      const speed = Number(values.speed);
      const maxPause = Number(values['max-pause']) * 1000;
      console.log(`Playing ${rest[0]} at ${speed} times its recorded pace. Ctrl-C stops it.`);
      const { events } = await play(sql, store, rest[0], {
        ...selection,
        speed,
        maxPause,
        onEvent: (event) => console.log(`#${event.work_item ?? '-'}  ${event.summary}`),
      });
      console.log(`Played ${events} events.`);
    } else if (command === 'export' && (values.all ? rest[0] : rest[0] && rest[1])) {
      const [item, dir] = values.all
        ? [null, rest[0] as string]
        : [rest[0]?.replace(/^#/, '') ?? null, rest[1] as string];
      const { events, artifacts } = await exportItem(sql, store, item, dir);
      console.log(`Exported ${events} events and ${artifacts} artifacts to ${dir}.`);
    } else {
      console.log(`Usage:\n${USAGE}`);
      return 2;
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  } finally {
    await sql.end();
  }
}
