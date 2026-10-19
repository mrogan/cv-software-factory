/**
 * The store's client: postgres.js, with metrics of its own, since OpenTelemetry's `pg` instrumentation does not cover
 * it. Every worker, the console and the store's own commands make their client here, so the series cover each once.
 *
 * - `store.query.duration`, in seconds, by `operation` (the statement's first word: `select`, `insert`, `begin`,
 *   or `other`) and `outcome` (`ok` or `error`), with the error's `code` when it failed: Postgres's SQLSTATE, such as
 *   `23505`, or the client's own, such as `CONNECTION_CLOSED` or `ECONNREFUSED`. It runs from when the query is asked
 *   for to its answer, so a wait for a free connection counts too.
 * - `store.connections`: the connections the client holds open now.
 * - `store.connection.attempts`, by `outcome`: `connected`, or `failed` for one that closed before it opened.
 *
 * Never a work item, a row or the statement's text: they would make a series of each, and a statement's text or
 * parameters can hold what a visitor wrote. Until `telemetry.ts` starts an SDK, the instruments are no-ops.
 */
import net from 'node:net';
import { metrics } from '@opentelemetry/api';
import postgres, { type Sql } from 'postgres';

type Options = NonNullable<Parameters<typeof postgres>[1]>;

/**
 * A client of the store, by URL, or by the standard PG* variables without one, with its notices kept off the log. The
 * options are postgres.js's own; given its own `socket`, a client's connections go uncounted.
 */
export function connect(url?: string, options: Options = {}): Sql {
  const settings = { onnotice: () => {}, ...options };
  const sql = url ? postgres(url, settings) : postgres(settings);
  timeQueries(sql);
  // One address, by host or by Unix socket, is all the factory uses: more hosts or ports, and postgres.js rotates
  // through them itself, by its ports, and its connections go uncounted.
  const { host, port } = sql.options;
  if (host.length === 1 && port.length === 1 && !('socket' in options)) {
    Object.assign(sql.options, { socket: countedSocket });
  }
  return sql;
}

// Made when they are first used, so the SDK telemetry.ts starts is the one they report to, and made again if another
// takes its place, as a test's does.
let made: { provider: unknown; instruments: ReturnType<typeof make> } | undefined;
function instruments() {
  const provider = metrics.getMeterProvider();
  if (made?.provider !== provider) made = { provider, instruments: make() };
  return made.instruments;
}
function make() {
  const meter = metrics.getMeter('factory-store');
  return {
    duration: meter.createHistogram('store.query.duration', {
      description: 'How long a query to the store took, a wait for a connection included',
      unit: 's',
      // Most of the store's queries take a few milliseconds; the default buckets start at five seconds.
      advice: {
        explicitBucketBoundaries: [0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      },
    }),
    connections: meter.createUpDownCounter('store.connections', {
      description: 'Connections to the store the client holds open',
    }),
    attempts: meter.createCounter('store.connection.attempts', {
      description: 'Connections to the store the client tried to open, by whether they opened',
    }),
  };
}

// The statement's first word, if it is one of these: anything else is `other`, so no text of a query makes a series.
const OPERATIONS = new Set([
  'select',
  'insert',
  'update',
  'delete',
  'with',
  'begin',
  'commit',
  'rollback',
  'savepoint',
  'release',
  'listen',
  'unlisten',
  'notify',
  'set',
  'lock',
  'copy',
  'create',
  'alter',
  'drop',
  'grant',
  'revoke',
  'truncate',
  'do',
]);
function operation(strings: readonly string[] | undefined): string {
  const word = strings?.[0]?.match(/^\s*([a-z]+)/i)?.[1]?.toLowerCase();
  return word && OPERATIONS.has(word) ? word : 'other';
}

// An error's code, if it looks like one: Postgres's five-character SQLSTATE, postgres.js's and Node's upper-case names.
const code = (error: unknown) => {
  const value = (error as { code?: unknown } | null)?.code;
  return typeof value === 'string' && /^[A-Z0-9_]{1,40}$/.test(value) ? value : 'unknown';
};

interface Query {
  strings?: readonly string[];
  executed: boolean;
  handle(): Promise<void>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

const TIMED = Symbol('store.timed');

/**
 * Times every query postgres.js runs in this process, a transaction's and a cursor's too. A query is a lazy promise
 * that runs when it is first awaited, through its `handle`: that is where the clock starts. It ends when postgres.js
 * settles the query through its `resolve` or `reject`, which a cursor replaces as it goes, so each replacement is
 * watched too. Nothing is attached to the promise, so a failed query nobody awaits fails as loudly as ever; a fragment
 * nested in another query never runs, and is never timed. The class is postgres.js's and is not exported, so it is
 * found from a query made and never run. Should a release of postgres.js change any of this, the client's tests fail.
 */
function timeQueries(sql: Sql) {
  const prototype = Object.getPrototypeOf(sql`select 1`) as Query & { [TIMED]?: true };
  const handle = prototype.handle;
  if (prototype[TIMED] || typeof handle !== 'function') return;
  prototype.handle = function (this: Query) {
    if (!this.executed) timeQuery(this);
    return handle.call(this);
  };
  prototype[TIMED] = true;
}

function timeQuery(query: Query) {
  const started = performance.now();
  const attributes = { operation: operation(query.strings) };
  let settled = false;
  const record = (extra: Record<string, string>) => {
    if (settled) return;
    settled = true;
    instruments().duration.record((performance.now() - started) / 1000, { ...attributes, ...extra });
  };
  for (const key of ['resolve', 'reject'] as const) {
    let current = query[key];
    const settle = (value: unknown) => {
      record(key === 'resolve' ? { outcome: 'ok' } : { outcome: 'error', code: code(value) });
      return current.call(query, value);
    };
    Object.defineProperty(query, key, {
      configurable: true,
      enumerable: true,
      get: () => settle,
      set: (replacement: typeof current) => {
        current = replacement;
      },
    });
  }
}

/**
 * The socket postgres.js would make, counted. It is returned connecting, as postgres.js's own is before it writes, so
 * what postgres.js writes waits for the connection, and its own timeout and errors apply as ever. Its `emit` is
 * watched rather than its events, since postgres.js takes every listener off a socket it then wraps in TLS.
 */
function countedSocket(options: { host: string[]; port: number[]; path: string | false }): net.Socket {
  const host = options.host[0] as string;
  const socket = options.path ? net.connect(options.path) : net.connect(options.port[0] as number, host);
  // postgres.js names the server for TLS from these, as it does on its own sockets.
  Object.assign(socket, { host, port: options.port[0] });
  let open = false;
  let ended = false;
  const emit = socket.emit;
  socket.emit = function (this: net.Socket, event: string | symbol, ...args: unknown[]) {
    if (event === 'connect' && !open && !ended) {
      open = true;
      instruments().connections.add(1);
      instruments().attempts.add(1, { outcome: 'connected' });
    } else if (event === 'close' && !ended) {
      ended = true;
      if (open) instruments().connections.add(-1);
      else instruments().attempts.add(1, { outcome: 'failed' });
    }
    return Reflect.apply(emit, this, [event, ...args]);
  } as typeof socket.emit;
  // Until postgres.js listens for it, which it does as soon as it has the socket, an error would end the process.
  socket.on('error', () => {});
  return socket;
}
