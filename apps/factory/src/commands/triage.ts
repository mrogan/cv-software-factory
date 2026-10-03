/**
 * `factory triage`: the triage worker (`packages/triage`), wired to the gateway, the page reader and the store.
 *
 *     factory triage
 *
 * Takes signals from the inbox until it is stopped. Settings come from the environment: GATEWAY_URL (the model
 * gateway), PAGES_URL (the probes' page reader, for a report's screenshot and the page's text; without it a report
 * is judged with neither), ARTIFACTS_DIR (where screenshots are), and DATABASE_URL or the PG* variables for the
 * store, which it connects to as the factory's writer.
 */
import type { Screenshot } from '@software-factory/events';
import { type Judge, type PageReader, Triage } from '@software-factory/triage';
import { INBOX } from '../../../../policy/triage.ts';

export const USAGE = '  factory triage';

export async function run(args: string[]): Promise<number> {
  const { GATEWAY_URL, PAGES_URL, ARTIFACTS_DIR, DATABASE_URL } = process.env;
  if (args.length || !GATEWAY_URL || !ARTIFACTS_DIR) {
    console.log(`Usage:\n${USAGE}\n\nSet GATEWAY_URL and ARTIFACTS_DIR, and PAGES_URL to read the pages reports name.`);
    return 2;
  }
  // The instrumentation goes in before the modules it patches are imported.
  const { shutdownTelemetry } = await import('../telemetry.ts');
  const { log } = await import('../log.ts');
  const { metrics } = await import('@opentelemetry/api');
  const { default: postgres } = await import('postgres');
  const { DiskArtifacts, EventWriter } = await import('@software-factory/store');
  const { GatewayClient } = await import('../gateway/client.ts');
  const { waitingFor } = await import('../gateway/waiting.ts');

  const sql = DATABASE_URL ? postgres(DATABASE_URL, { onnotice: () => {} }) : postgres({ onnotice: () => {} });
  const gateway = new GatewayClient({ url: GATEWAY_URL });

  const judge: Judge = async (request) => {
    try {
      return await gateway.judge(request);
    } catch (error) {
      throw waitingFor(error, new Date()) ?? error;
    }
  };

  const read: PageReader = async (path) => {
    if (!PAGES_URL) return null;
    try {
      const response = await fetch(`${PAGES_URL.replace(/\/$/, '')}/v1/pages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`the page reader answered ${response.status}`);
      return (await response.json()) as { screenshot: Screenshot; passages: string[] };
    } catch (error) {
      // A report is still judged without its page: it just has no screenshot, and no passage to point to.
      log.warn({ path, reason: error instanceof Error ? error.message : String(error) }, 'could not read the page');
      return null;
    }
  };

  const meter = metrics.getMeter('factory-triage');
  const triaged = meter.createCounter('factory.triage.signals', {
    description: 'Signals triaged, by sense and outcome (opened, evidence, counted, report)',
  });
  const toTicket = meter.createHistogram('factory.triage.signal_to_ticket', {
    description: 'From a sense seeing something to its ticket opening',
    unit: 's',
  });
  meter
    .createObservableGauge('factory.inbox.waiting', { description: 'Signals in the inbox waiting for triage' })
    .addCallback(async (gauge) => {
      const [row] = await sql<{ waiting: number; failed: number }[]>`
        select count(*) filter (where attempts < ${INBOX.attempts})::int as waiting,
               count(*) filter (where attempts >= ${INBOX.attempts})::int as failed
        from inbox where triaged_at is null`.catch(() => []);
      if (row) {
        gauge.observe(row.waiting, { state: 'waiting' });
        gauge.observe(row.failed, { state: 'failed' });
      }
    });

  const triage = new Triage({
    sql,
    events: new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts(ARTIFACTS_DIR) }),
    judge,
    read,
    log,
    onTriaged: (outcome, signal, _waited, ticketOpened) => {
      triaged.add(1, { sense: signal.sense, outcome });
      if (ticketOpened) {
        toTicket.record((Date.now() - Date.parse(signal.observedAt)) / 1000, { sense: signal.sense });
      }
    },
  });

  const abort = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      log.info({ signal }, 'triage stopping');
      abort.abort();
    });
  }
  log.info({ gateway: GATEWAY_URL, pages: PAGES_URL ?? null }, 'triage taking signals from the inbox');
  try {
    await triage.run(abort.signal);
    return 0;
  } finally {
    await Promise.all([sql.end(), shutdownTelemetry()]);
  }
}
