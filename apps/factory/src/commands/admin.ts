/**
 * `factory admin`: the admin service, Martin's one way to change the factory from a browser (`admin/`), and
 * `factory admin enrol`, the one way to add a passkey.
 *
 *     factory admin
 *     factory admin enrol [--revoke-others]
 *
 * The service serves under `/admin/` on PORT (default 8080), until it is stopped, with its settings from ADMIN_ORIGIN,
 * ADMIN_RP_ID and ADMIN_TRUSTED_PROXIES (`admin/config.ts`). It connects with DATABASE_URL, or the PG* variables, as
 * its own role, `factory_admin`.
 *
 * `enrol` connects as `factory_enrol`, whose password no pod holds: `make enrol` runs it. It prints a one-time code
 * for the console's enrolment page. `--revoke-others` first revokes every passkey and ends every session, to recover
 * from a lost or stolen device.
 */
import { parseArgs } from 'node:util';

export const USAGE = '  factory admin\n  factory admin enrol [--revoke-others]';

export async function run(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'enrol') return enrol(rest);
  if (command !== undefined) {
    console.log(`Usage:\n${USAGE}`);
    return 2;
  }
  return serve();
}

async function enrol(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { 'revoke-others': { type: 'boolean', default: false } } });
  const { enrol: makeCode, described } = await import('../admin/enrol.ts');
  const { connect } = await import('@software-factory/store');
  const sql = connect(process.env.DATABASE_URL);
  try {
    console.log(described(await makeCode(sql, { revokeOthers: values['revoke-others'] })));
    return 0;
  } finally {
    await sql.end();
  }
}

async function serve(): Promise<number> {
  const { configFromEnv } = await import('../admin/config.ts');
  let config: ReturnType<typeof configFromEnv>;
  try {
    config = configFromEnv(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 2;
  }
  // The instrumentation goes in before the modules it patches are imported.
  const { shutdownTelemetry } = await import('../telemetry.ts');
  const { startAdmin } = await import('../admin/service.ts');
  const { log } = await import('../log.ts');
  const { stop } = await startAdmin(config);

  // Kubernetes sends SIGTERM before it stops the pod: close the streams, finish the requests in flight, flush telemetry.
  return new Promise<number>((resolve) => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        log.info({ signal }, 'admin service stopping');
        void Promise.all([stop(), shutdownTelemetry()]).then(
          () => resolve(0),
          () => resolve(1),
        );
      });
    }
  });
}
