/**
 * `factory intake`: the server that takes Alertmanager's webhook and leaves each firing alert in the inbox.
 *
 *     node --import ./src/telemetry.ts src/cli.ts intake [--dry-run]
 *
 * With `--dry-run` it prints the signals instead of leaving them in the inbox. PORT sets the port (default 8080).
 * Connects with DATABASE_URL, or the PG* variables, as the factory's writer; finds Prometheus and Loki as
 * `clients/env.ts` says. Run with the preload, it sends its own traces, metrics and logs to the collector.
 */
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import { objectives } from '../../../../policy/objectives.ts';
import { telemetryFrom } from '../clients/env.ts';
import { createIntake } from '../intake/server.ts';
import { log } from '../log.ts';
import { inbox, printing } from '../outbox.ts';

export const USAGE = '  factory intake [--dry-run]';

export async function run(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { 'dry-run': { type: 'boolean', default: false } } });
  const { DATABASE_URL, PORT } = process.env;
  const sql = values['dry-run']
    ? undefined
    : DATABASE_URL
      ? postgres(DATABASE_URL, { onnotice: () => {} })
      : postgres({ onnotice: () => {} });
  const { prometheus, loki } = telemetryFrom();
  const outbox = sql ? inbox(sql) : printing((line) => console.log(line));

  const server = createServer(
    createIntake({ backends: { objectives, prometheus, loki, now: () => new Date() }, outbox, log }),
  );
  const port = Number(PORT ?? 8080);
  server.listen(port, () => log.info({ port, dryRun: !sql }, `intake listening on :${port}`));

  // Kubernetes sends SIGTERM before it stops the pod: finish the requests in flight, then flush telemetry.
  await new Promise<void>((resolve) => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        log.info({ signal }, 'intake stopping');
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });
  await sql?.end();
  return 0;
}
