/**
 * The console and the admin service on one origin, as the cluster serves them, for the browser tests of signing in and
 * of Martin's view, and for the ZAP scan (`apps/console/zap`): a throwaway store holding the samples, each visitor's
 * report with its text as the full events carry it (`full.ts`), the admin service and the console's server on it, each
 * as its own role, and a small proxy in front standing in for Traefik, which sends `/admin/` to the service and
 * everything else to the console's server without the `Cookie` header. So Martin's full events and a visitor's public
 * ones are the same events, from one store. It exists in the tests alone: nothing here is in an image.
 *
 * A browser signs in as Martin's would, with a virtual passkey (Chrome's WebAuthn domain, through the DevTools
 * Protocol) answering the service's own ceremonies, so the service has no way in made for tests.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { CDPSession, Page } from '@playwright/test';
import type { NewEvent } from '@software-factory/events';
import { DiskArtifacts, EventWriter } from '@software-factory/store';
import { createDatabase, type Database, PASSWORDS, startPostgres } from '../../../packages/store/test/postgres.ts';
import type { AdminService } from '../../factory/src/admin/service.ts';
import type { RolloutRef } from '../../factory/src/release/rollout-ref.ts';
import type { KubeWriter } from '../../factory/src/runners/kube.ts';
import { full } from './full.ts';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const SAMPLES = fileURLToPath(new URL('../../../packages/samples/log', import.meta.url));
const ARTIFACTS = fileURLToPath(new URL('../../../packages/samples/log/artifacts', import.meta.url));

export interface Harness {
  /** The one origin the browser sees, such as `http://localhost:18325`. */
  origin: string;
  database: Database;
  /** A one-time code, as `factory admin enrol` prints it. */
  code(): Promise<string>;
  /** Whether a request ever reached the console's server with a cookie: the proxy strips it, as Traefik does. */
  cookiesToConsole: number;
  stop(): Promise<void>;
}

/**
 * Starts the store, the admin service, the console's server and the proxy, with the proxy listening on `port`. With
 * `release`, the admin service controls that Rollout, through a stand-in for Kubernetes.
 */
export async function startHarness(
  port: number,
  name = 'admin',
  release?: { rollout: RolloutRef; kube: KubeWriter },
): Promise<Harness> {
  const given = process.env.TEST_DATABASE_URL;
  const postgres = given ? { url: given, stop: () => {} } : await startPostgres();
  const database = await createDatabase(postgres.url, name);
  const origin = `http://localhost:${port}`;
  // The service logs each request; here only what went wrong. Its logger reads this as its module loads.
  process.env.LOG_LEVEL ??= 'warn';
  const { proxies } = await import('../../factory/src/admin/config.ts');
  const { enrol } = await import('../../factory/src/admin/enrol.ts');
  const { startAdmin } = await import('../../factory/src/admin/service.ts');
  const { endingAt, readLog } = await import('../../factory/src/events.ts');

  // The samples, as `make samples` loads them, by Martin's command line's role, ending now.
  const events = endingAt(readLog(SAMPLES).map(full<NewEvent>), Date.now());
  await new EventWriter(database.operator, { kind: 'sample', artifacts: new DiskArtifacts(ARTIFACTS) }).append(events);

  // The admin service as its Deployment runs it, connected as its own role; `localhost` is a secure context, so a
  // passkey and a `Secure` cookie work over plain HTTP here.
  const admin: AdminService = await startAdmin(
    { origin, rpId: 'localhost', trusted: proxies(''), port: 0, ...(release && { rollout: release.rollout }) },
    { sql: database.admin, port: 0, ...(release && { kube: release.kube }) },
  );
  const adminPort = (admin.server.address() as AddressInfo).port;

  const consolePort = port + 1;
  const reader = new URL(postgres.url);
  reader.pathname = `/${database.name}`;
  reader.username = 'console_reader';
  reader.password = PASSWORDS.console;
  const console_ = await startConsole(consolePort, reader.href);

  const harness: Harness = {
    origin,
    database,
    code: async () => (await enrol(database.enrol)).code,
    cookiesToConsole: 0,
    stop: async () => {
      await new Promise<void>((resolve) => {
        proxy.close(() => resolve());
        proxy.closeAllConnections();
      });
      await stopConsole(console_);
      await admin.stop();
      await database.end();
      postgres.stop();
    },
  };

  const proxy: Server = createServer((req, res) => {
    const toAdmin = (req.url ?? '/').startsWith('/admin/');
    const headers = { ...req.headers };
    if (!toAdmin) {
      if (headers.cookie) harness.cookiesToConsole++;
      delete headers.cookie;
    }
    forward(req, res, toAdmin ? adminPort : consolePort, headers);
  });
  await new Promise<void>((resolve) => proxy.listen(port, '127.0.0.1', resolve));
  return harness;
}

function forward(req: IncomingMessage, res: ServerResponse, port: number, headers: IncomingMessage['headers']) {
  const upstream = request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
}

/** The console's server on the store, as its read-only role, as the cluster runs it. */
async function startConsole(port: number, databaseUrl: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['src/server.ts'], {
    cwd: HERE,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      ARTIFACTS_DIR: ARTIFACTS,
      NODE_ENV: 'production',
      LOG_LEVEL: 'silent',
      OTEL_SDK_DISABLED: 'true',
    },
    stdio: 'ignore',
  });
  for (let tries = 0; tries < 100; tries++) {
    const up = await fetch(`http://127.0.0.1:${port}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (up) return child;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill('SIGKILL');
  throw new Error('The console did not start');
}

async function stopConsole(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

/**
 * A passkey on this page's device: a virtual authenticator, built in like a laptop's or a phone's, that verifies its
 * user and keeps resident keys, as Martin's do. Each page has its own, with no passkey until one is made.
 */
export async function virtualPasskey(page: Page): Promise<{ cdp: CDPSession; id: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, id: authenticatorId };
}

/** Enrols a passkey on the page's device with a code, through the enrolment door, as Martin would. */
export async function enrolThroughTheDoor(page: Page, code: string, name = 'Laptop'): Promise<void> {
  await page.goto('/?view=enrol');
  await page.getByLabel('One-time code').fill(code);
  await page.getByRole('button', { name: 'Check the code' }).click();
  await page.getByLabel('Name this passkey').fill(name);
  await page.getByRole('button', { name: 'Make a passkey' }).click();
  await page.getByText('Passkey made, and you are signed in on this device.').waitFor();
}
