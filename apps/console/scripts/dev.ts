/**
 * `pnpm dev`: the console on http://localhost:8080, with hot reloading.
 *
 * Vite serves the page on :8080 and passes events, artifacts, /health and /version to the Node server on :8081,
 * which restarts when its code changes. With PGHOST or DATABASE_URL set, the server reads the event store (see
 * AGENTS.md for forwarding the cluster's); otherwise it serves the samples' event log.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
const samples = fileURLToPath(new URL('../../../packages/samples/log', import.meta.url));
const live = Boolean(process.env.PGHOST || process.env.DATABASE_URL);

const children: ChildProcess[] = [];
function run(name: string, command: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(command, args, { cwd: here, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `[${name}] `;
  for (const output of [child.stdout, child.stderr]) {
    output?.on('data', (chunk: Buffer) => process.stdout.write(chunk.toString().replace(/^(?=.)/gm, prefix)));
  }
  child.on('exit', (code) => {
    if (code) console.error(`${prefix}stopped with code ${code}`);
    for (const other of children) other.kill();
    process.exitCode = code ?? 0;
  });
  children.push(child);
}

run('server', process.execPath, ['--watch', '--import', './src/telemetry.ts', 'src/server.ts'], {
  PORT: '8081',
  ...(live ? {} : { EVENT_LOG: samples }),
});
run('vite', process.execPath, [fileURLToPath(import.meta.resolve('vite/bin/vite.js'))]);
console.log(`The console: http://localhost:8080, with ${live ? 'the event store' : 'the samples'} behind it.`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    for (const child of children) child.kill();
  });
}
