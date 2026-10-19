/**
 * `factory scoreboard`: the only reader of the answer key (spec section 3.2). It counts the store's tickets against
 * the key and appends `score.updated` when a figure it publishes changes (`scoreboard/`).
 *
 *     factory scoreboard
 *     factory scoreboard --print
 *
 * Runs until stopped, looking again whenever an event is appended and every minute, so found moves at its cadence's
 * boundary with nothing appended. `--print` counts once, now, and prints the four figures, false positives too, for
 * the results; never an id, a fingerprint or a ticket. In the cluster, Martin runs it in the scoreboard's own pod.
 *
 * ANSWER_KEY_FILE is the key's path, a JSON file of `[{id, fingerprint}]`; with no file there, the scoreboard is off
 * and says so once. It connects with DATABASE_URL, or the PG* variables, as the scoreboard's own role, which may read
 * the events and append them and do nothing else. It sends no telemetry: its pod reaches Postgres alone.
 */
import { parseArgs } from 'node:util';
import { connect, DiskArtifacts, EventWriter, listen, storeKind } from '@software-factory/store';
import type { Sql } from 'postgres';
import { log } from '../log.ts';
import { figures, tickets } from '../scoreboard/figures.ts';
import { loadKey } from '../scoreboard/key.ts';
import { wakeLoop } from '../scoreboard/loop.ts';
import { readScoreEvents, Scoreboard } from '../scoreboard/worker.ts';

export const USAGE = '  factory scoreboard [--print]';

const EVERY_MS = 60_000;

export async function run(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { print: { type: 'boolean', default: false } } });
  const { ANSWER_KEY_FILE, DATABASE_URL } = process.env;
  const key = ANSWER_KEY_FILE ? await loadKey(ANSWER_KEY_FILE) : null;
  const sql = connect(DATABASE_URL);
  try {
    return values.print ? await print(sql, key) : await serve(sql, key);
  } finally {
    await sql.end();
  }
}

async function print(sql: Sql, key: Awaited<ReturnType<typeof loadKey>>): Promise<number> {
  if (!key) {
    console.error('There is no answer key: set ANSWER_KEY_FILE to its file.');
    return 2;
  }
  if ((await storeKind(sql)) !== 'real') {
    console.error('The store holds no real events: there is nothing to count.');
    return 1;
  }
  const all = tickets(await readScoreEvents(sql));
  const score = figures(all, key, Date.now());
  const minutes = score.medianMs === null ? 'none yet' : `${(score.medianMs / 60_000).toFixed(1)} minutes`;
  console.log(
    [
      `Found            ${score.found} of ${score.entries}`,
      `Verified fixed   ${score.verified} of ${score.entries}`,
      `Median to a fix  ${minutes}`,
      `False positives  ${score.falsePositives} of ${all.length} tickets`,
    ].join('\n'),
  );
  return 0;
}

async function serve(sql: Sql, key: Awaited<ReturnType<typeof loadKey>>): Promise<number> {
  // Line events carry no artifacts, so the writer never looks in the artifact store.
  const events = new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts('/nonexistent') });
  const scoreboard = new Scoreboard({ sql, events, key });

  log.info({ keyed: key !== null }, key ? 'scoreboard counting' : 'scoreboard off: no answer key');
  await wakeLoop(
    {
      listen: (wake) => listen(sql, wake, wake),
      pass: async () => {
        const result = await scoreboard.pass();
        if (result.pass === 'published') log.info({ score: result.score }, 'scoreboard published');
      },
      failed: (error) => log.error({ err: error }, 'scoreboard pass failed'),
      everyMs: EVERY_MS,
    },
    () =>
      new Promise<void>((resolve) => {
        for (const signal of ['SIGTERM', 'SIGINT'] as const) {
          process.once(signal, () => {
            log.info({ signal }, 'scoreboard stopping');
            resolve();
          });
        }
      }),
  );
  return 0;
}
