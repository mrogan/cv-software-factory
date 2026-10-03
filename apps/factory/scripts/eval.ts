/**
 * `make eval`: the evaluation set against Jev, live (TYPESAFE.md, "Evaluation").
 *
 *     TYPESAFE_API_KEY=… node apps/factory/scripts/eval.ts [--runs 3]
 *
 * The first run records a cassette for every request into `apps/factory/eval/cassettes`, which CI replays, and
 * removes cassettes no request used. Later runs call Jev again without recording, to show how far its answers
 * drift. It prints each report's route, each deciding probability's margin from its threshold, and every report
 * within the margin on any run. The calls go through the gateway, against a throwaway Postgres for its ledger.
 */
import { readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DiskArtifacts, EventWriter, migrate } from '@software-factory/store';
import { pino } from 'pino';
import postgres from 'postgres';
// The store's tests start a Postgres in Docker the same way.
import { startPostgres } from '../../../packages/store/test/postgres.ts';
import { SPEND } from '../../../policy/spend.ts';
import { close, evaluate, MARGIN, type Outcome } from '../eval/evaluate.ts';
import { Cassettes } from '../src/gateway/cassettes.ts';
import { Gateway } from '../src/gateway/gateway.ts';
import { Spend } from '../src/gateway/spend.ts';
import { TypeSafe } from '../src/gateway/typesafe.ts';

const CASSETTES = fileURLToPath(new URL('../eval/cassettes/', import.meta.url));
const { values } = parseArgs({ options: { runs: { type: 'string', default: '1' } } });
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1) {
  console.error(`--runs takes a whole number of runs, at least 1, not "${values.runs}".`);
  process.exit(2);
}
const key = process.env.TYPESAFE_API_KEY;
if (!key) {
  console.error('Set TYPESAFE_API_KEY (make eval reads it from the Keychain).');
  process.exit(2);
}

const log = pino({ level: 'warn' });
const database = await startPostgres();
const sql = postgres(database.url, { onnotice: () => {} });
try {
  await migrate(sql);
  const events = new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts(CASSETTES) });
  const spend = new Spend({ sql, events, profile: 'local', policy: SPEND.local, log });
  const typesafe = new TypeSafe({ apiKey: key, log });
  const used = new Set<string>();
  const results: Outcome[][] = [];
  for (let run = 0; run < runs; run++) {
    const gateway = new Gateway({
      sql,
      spend,
      cassettes: new Cassettes({ record: CASSETTES }),
      mode: run === 0 ? 'record' : 'live',
      typesafe,
      log,
    });
    results.push(
      await evaluate(async (request) => {
        const judged = await gateway.judge(request);
        if (run === 0) used.add(judged.cassette);
        return judged;
      }),
    );
  }
  // Only a run that recorded every request knows which cassettes are no longer used.
  for (const file of used.size ? readdirSync(CASSETTES) : []) {
    if (file.endsWith('.json') && !used.has(file.slice(0, -5))) rmSync(`${CASSETTES}${file}`);
  }

  const [first = []] = results;
  const width = Math.max(...first.map((o) => o.report.id.length));
  console.log(`${'report'.padEnd(width)}  expected, then each run   deciding probabilities (threshold)`);
  for (const [i, outcome] of first.entries()) {
    const all = results.map((r) => r[i] as Outcome);
    const routes = all.map((o) => (o.pass ? '✓' : `✕ ${describe(o.got)}`)).join(' ');
    const deciding = outcome.deciding
      .map(
        (d) => `${d.name} ${range(all.map((o) => o.deciding.find((x) => x.name === d.name)?.p ?? 0))} (${d.threshold})`,
      )
      .join(', ');
    const flag = `${all.some(close) ? '  ⚠ within margin' : ''}${outcome.report.known ? `  known: ${outcome.report.known.cause}` : ''}`;
    console.log(
      `${outcome.report.id.padEnd(width)}  ${describe(outcome.report.expect)} ${routes}   ${deciding}${flag}`,
    );
  }
  const failed = results.flatMap((r) => r.filter((o) => !o.pass && !o.report.known));
  const known = first.filter((o) => o.report.known);
  const near = first.filter((_, i) => results.some((r) => close(r[i] as Outcome)));
  console.log(
    `\n${first.length} reports, ${runs} run${runs > 1 ? 's' : ''}: ${failed.length} unexpected routes, ` +
      `${near.length} within ${MARGIN} of a threshold, ${known.length} known failures. Cassettes: ${used.size}.`,
  );
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await sql.end();
  database.stop();
}

function describe(route: { route: string | string[]; category?: string | string[] | undefined; joined?: string }) {
  const either = (value: string | string[] | undefined) => (Array.isArray(value) ? value.join('/') : value);
  return [either(route.route), either(route.category) ?? route.joined].filter(Boolean).join(' ');
}

function range(ps: number[]) {
  const [lo, hi] = [Math.min(...ps), Math.max(...ps)];
  return lo === hi ? lo.toFixed(2) : `${lo.toFixed(2)}–${hi.toFixed(2)}`;
}
