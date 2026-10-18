import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { DiskArtifacts, issueJobToken, jobForToken } from '@software-factory/store';
import pino, { type Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../packages/store/test/database.ts';
import { type Handback, RESULT_BYTES as RUNNER_RESULT_BYTES, type Step } from '../../runner/src/step.ts';
import { agentJob, prepareJob } from '../src/runners/jobs.ts';
import type { Kube } from '../src/runners/kube.ts';
import { StepLogs } from '../src/runners/logs.ts';
import { fence, ownedPaths } from '../src/runners/scope.ts';
import { lineServers } from '../src/runners/serve.ts';
import { RESULT_BYTES, Runners } from '../src/runners/steps.ts';
import { quiet } from './github/fake.ts';

const PATCH = (path: string) => `diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -1 +1 @@
-old
+new
`;

describe('the scope fence', () => {
  it('lets through only the files, folders and patterns the scope names', () => {
    const scope = ['src/money.ts', 'test/', 'src/pages/*.ts'];
    expect(
      fence(PATCH('src/money.ts') + PATCH('test/money.test.ts') + PATCH('src/pages/home.ts'), scope),
    ).toMatchObject({ ok: true });
    expect(fence(PATCH('src/pages/deep/home.ts') + PATCH('src/app.ts'), scope)).toMatchObject({
      ok: false,
      outside: ['src/pages/deep/home.ts', 'src/app.ts'],
    });
  });

  it('never lets through the workflows, the deployment or a code-owned path, whatever the scope says', () => {
    const owned = ownedPaths('# The rules\n/Dockerfile  @mrogan\n/deploy/ @mrogan\npackage.json @mrogan\n');
    expect(owned).toEqual(['Dockerfile', 'deploy/', '**/package.json']);
    const result = fence(
      PATCH('.github/workflows/check.yml') + PATCH('Dockerfile') + PATCH('apps/package.json'),
      ['**'],
      owned,
    );
    expect(result.outside).toEqual(['.github/workflows/check.yml', 'Dockerfile', 'apps/package.json']);
  });

  it('prints the scope, then each file it allowed or refused, with its lines', () => {
    const patch = PATCH('src/money.ts') + PATCH('src/pages/cards.ts');
    const scope = ['src/money.ts', 'test/money.test.ts'];
    expect(fence(patch, scope)).toEqual({
      ok: false,
      paths: ['src/money.ts', 'src/pages/cards.ts'],
      outside: ['src/pages/cards.ts'],
      files: [
        { path: 'src/money.ts', added: 1, removed: 1, allowed: true },
        { path: 'src/pages/cards.ts', added: 1, removed: 1, allowed: false },
      ],
      output: [
        'scope: src/money.ts, test/money.test.ts',
        'allowed src/money.ts +1 −1',
        'refused src/pages/cards.ts +1 −1',
      ].join('\n'),
    });
  });

  it('cuts its output at a whole line, and says how many more there were', () => {
    const patch = Array.from({ length: 300 }, (_, i) => PATCH(`src/pages/page-${i}.ts`)).join('');
    const { output } = fence(patch, ['src/money.ts']);
    expect(output.length).toBeLessThanOrEqual(4000);
    const lines = output.split('\n');
    expect(lines.slice(1, -1).every((line) => /^refused src\/pages\/page-\d+\.ts \+1 −1$/.test(line))).toBe(true);
    expect(lines.at(-1)).toBe(`… and ${300 - (lines.length - 2)} more`);
  });
});

const STEP: Step = {
  agent: 'coder',
  repository: 'https://github.com/mrogan/cv-worlds-worst-website.git',
  commit: 'a'.repeat(40),
  prompt: 'Fix it.',
  maxTurns: 10,
};

describe('a runner’s jobs', () => {
  const names = { job: 'coder-1001-1-1', workItem: '1001' };

  it('run restricted, with no service account token, on the work item’s volume, with a deadline', () => {
    const job = prepareJob(names, STEP, { image: 'runner@sha256:abc', deadlineSeconds: 600 });
    const pod = job.spec.template.spec;
    expect(job.metadata).toMatchObject({ name: 'coder-1001-1-1-prepare', namespace: 'runners' });
    expect(job.spec).toMatchObject({ backoffLimit: 0, activeDeadlineSeconds: 660 });
    // The pod's deadline, so a pod out of time stays, with its log, for the line to keep.
    expect(pod).toMatchObject({ activeDeadlineSeconds: 600 });
    expect(pod).toMatchObject({ automountServiceAccountToken: false, securityContext: { runAsNonRoot: true } });
    expect(pod.containers[0]?.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    });
    expect(pod.volumes[0]).toEqual({ name: 'work', persistentVolumeClaim: { claimName: 'work-1001' } });
    expect(job.metadata.labels['factory.mrogan.dev/runner']).toBe('prepare');
  });

  it('give only the agent pod its job token, the gateway and the handback', () => {
    const settings = {
      image: 'runner',
      deadlineSeconds: 1200,
      gatewayUrl: 'http://gateway',
      handbackUrl: 'http://line/v1/handback',
      token: 'sfj_x',
      hosts: [{ ip: '10.43.0.9', hostnames: ['gateway'] }],
    };
    const agentEnv = Object.fromEntries(
      agentJob(names, STEP, settings).spec.template.spec.containers[0]?.env.map((e) => [e.name, e.value]) ?? [],
    );
    const prepareEnv = Object.fromEntries(
      prepareJob(names, STEP, settings).spec.template.spec.containers[0]?.env.map((e) => [e.name, e.value]) ?? [],
    );
    expect(agentEnv).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://gateway',
      ANTHROPIC_API_KEY: 'sfj_x',
      HANDBACK_URL: 'http://line/v1/handback',
    });
    expect(prepareEnv).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(JSON.parse(agentEnv.RUNNER_STEP ?? '{}')).toEqual(STEP);
  });

  it('give the agent pod the addresses it needs and no DNS, which would be a way out', () => {
    const hosts = [{ ip: '10.43.0.9', hostnames: ['gateway'] }];
    const settings = { image: 'runner', deadlineSeconds: 1200, gatewayUrl: '', handbackUrl: '', token: '', hosts };
    expect(agentJob(names, STEP, settings).spec.template.spec).toMatchObject({
      dnsPolicy: 'None',
      dnsConfig: { nameservers: ['127.0.0.1'] },
      hostAliases: hosts,
    });
    expect(prepareJob(names, STEP, settings).spec.template.spec).not.toHaveProperty('dnsPolicy');
  });
});

/** What each pod prints, by its part, or `refused` for a log the API will not give, as for a pod that never started. */
type PodLogs = Partial<Record<'prepare' | 'agent', string>>;

/**
 * The Kubernetes API, as far as the line uses it: Jobs that end as each test says, each with a pod that prints what
 * the test says, which goes with its Job, and a record of every call.
 */
function fakeKube(
  agent: (env: Record<string, string>) => void | Promise<void>,
  prepare: 'succeeded' | 'failed' = 'succeeded',
  logs: PodLogs = {},
  /** Whether a failed prepare pod failed at its own deadline. */
  outOfTime = false,
) {
  const calls: string[] = [];
  const jobs = new Map<string, { status: Record<string, unknown> }>();
  const pods = new Map<
    string,
    { job: string; labels: Record<string, string>; log: string | undefined; reason: string | undefined }
  >();
  const kube: Kube = {
    async get<T>(path: string) {
      calls.push(`GET ${path}`);
      const selector = /\/pods\?labelSelector=(.+)$/.exec(path)?.[1];
      if (selector) {
        const [key, value] = decodeURIComponent(selector).split('=');
        const items = [...pods].filter(([, pod]) => pod.labels[key ?? ''] === value);
        return {
          items: items.map(([name, pod]) => ({
            metadata: { name, labels: pod.labels },
            status: { reason: pod.reason },
          })),
        } as T;
      }
      return jobs.get(path.split('/').at(-1) ?? '') as T | undefined;
    },
    async text(path: string) {
      calls.push(`GET ${path}`);
      const name = /\/pods\/([^/]+)\/log\?/.exec(path)?.[1] ?? '';
      const pod = pods.get(name);
      if (!pod) return undefined;
      if (pod.log === 'refused') throw new Error('container "agent" in pod is waiting to start');
      return pod.log ?? '';
    },
    async create(path: string, body: unknown) {
      const manifest = body as {
        kind: string;
        metadata: { name: string };
        spec: {
          template?: {
            metadata: { labels: Record<string, string> };
            spec: { containers: { env: { name: string; value: string }[] }[] };
          };
        };
      };
      calls.push(`POST ${path} ${manifest.kind} ${manifest.metadata.name}`);
      if (manifest.kind !== 'Job') return;
      const name = manifest.metadata.name;
      const labels = manifest.spec.template?.metadata.labels ?? {};
      const part = labels['factory.mrogan.dev/runner'] as 'prepare' | 'agent';
      const reason = outOfTime && part === 'prepare' ? 'DeadlineExceeded' : undefined;
      pods.set(`${name}-x7k2p`, { job: name, labels: { ...labels, 'job-name': name }, log: logs[part], reason });
      if (name.endsWith('-prepare')) {
        jobs.set(name, {
          status: prepare === 'succeeded' ? { succeeded: 1 } : { conditions: [{ type: 'Failed', status: 'True' }] },
        });
        return;
      }
      jobs.set(name, { status: {} });
      const env = Object.fromEntries(
        manifest.spec.template?.spec.containers[0]?.env.map((e) => [e.name, e.value]) ?? [],
      );
      // The pod runs, and ends a moment after.
      setTimeout(async () => {
        await agent(env);
        jobs.set(name, { status: { succeeded: 1 } });
      }, 10);
    },
    async remove(path: string) {
      calls.push(`DELETE ${path}`);
      const name = path.split('/').at(-1) ?? '';
      jobs.delete(name);
      // A Job's pods go with it.
      for (const [pod, { job }] of pods) if (job === name) pods.delete(pod);
    },
  };
  return { kube, calls };
}

let database: Database;
beforeAll(async () => {
  database = await freshDatabase('runners');
});
afterAll(() => database?.end());

async function line(
  agent: Parameters<typeof fakeKube>[0],
  prepare?: 'succeeded' | 'failed',
  log: Logger = quiet,
  { podLogs, logs, hang, outOfTime }: { podLogs?: PodLogs; logs?: StepLogs; hang?: boolean; outOfTime?: boolean } = {},
) {
  const { kube, calls } = fakeKube(agent, prepare, podLogs, outOfTime);
  // An API that never gives a pod's log.
  if (hang) kube.text = () => new Promise(() => {});
  let handbackUrl = '';
  const runners = new Runners({
    sql: database.writer,
    kube,
    image: 'runner',
    gatewayUrl: 'http://gateway',
    handbackUrl: 'http://line/v1/handback',
    log,
    ...(logs ? { logs } : {}),
    logWaitMs: 50,
    pollMs: 10,
    graceMs: 10,
    lookup: async () => '10.43.0.9',
  });
  const server: Server = createServer(runners.handback());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  handbackUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/handback`;
  return { runners, calls, handbackUrl, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const handBack = (url: string, token: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

const DONE: Handback = {
  ending: 'finished',
  patch: PATCH('src/money.ts'),
  note: 'Fixed the rounding.',
  turns: 7,
  session: 'abc',
};

describe('running a step', () => {
  it('prepares, runs the agent, takes its handback once, ends its token and cleans up', async () => {
    let token = '';
    const answers: number[] = [];
    let agentDone: Promise<void> = Promise.resolve();
    const { runners, calls, handbackUrl, close } = await line((env) => {
      token = env.ANTHROPIC_API_KEY ?? '';
      agentDone = (async () => {
        answers.push((await handBack(handbackUrl, 'sfj_not-this-one', DONE)).status);
        answers.push((await handBack(handbackUrl, token, { ...DONE, patch: 7 })).status);
        answers.push((await handBack(handbackUrl, token, DONE)).status);
      })();
      return agentDone;
    });
    const outcome = await runners.run({ ...STEP, workItem: '1001', round: 1, deadlineSeconds: 60 });
    await agentDone;
    // Once the step is over, its token has ended.
    answers.push((await handBack(handbackUrl, token, DONE)).status);
    await close();
    expect(outcome).toEqual({ kind: 'handed-back', job: 'coder-1001-1-1', handback: DONE });
    // A stranger's token, a body that is not a handback, the handback, and a second one, by when the token has ended.
    expect(answers).toEqual([401, 400, 202, 401]);
    expect(await jobForToken(database.writer, token)).toBeUndefined();
    expect(calls.filter((c) => !c.startsWith('GET'))).toEqual([
      'POST /api/v1/namespaces/runners/persistentvolumeclaims PersistentVolumeClaim work-1001',
      'POST /apis/batch/v1/namespaces/runners/jobs Job coder-1001-1-1-prepare',
      'POST /apis/batch/v1/namespaces/runners/jobs Job coder-1001-1-1-agent',
      'DELETE /apis/batch/v1/namespaces/runners/jobs/coder-1001-1-1-prepare',
      'DELETE /apis/batch/v1/namespaces/runners/jobs/coder-1001-1-1-agent',
    ]);
  });

  it('deletes the work volume when the work item is over', async () => {
    const { runners, calls, close } = await line(() => {});
    await runners.finish('1001');
    await close();
    expect(calls).toEqual(['DELETE /api/v1/namespaces/runners/persistentvolumeclaims/work-1001']);
  });

  it('says so when the prepare pod fails, and never starts the agent', async () => {
    const { runners, calls, close } = await line(() => {}, 'failed');
    const outcome = await runners.run({ ...STEP, workItem: '1002', round: 1, deadlineSeconds: 60 });
    await close();
    expect(outcome).toEqual({ kind: 'failed', job: 'coder-1002-1-1', reason: 'The prepare pod failed.' });
    expect(calls.some((c) => c.includes('agent') && c.startsWith('POST'))).toBe(false);
  });

  it('says a step ran out of time when its pod failed at its own deadline', async () => {
    const { runners, close } = await line(() => {}, 'failed', quiet, { outOfTime: true });
    const outcome = await runners.run({ ...STEP, workItem: '1025', round: 1, deadlineSeconds: 60 });
    await close();
    expect(outcome).toEqual({ kind: 'failed', job: 'coder-1025-1-1', reason: 'The prepare pod ran out of time.' });
  });

  it('says so when the agent pod ends without handing anything back', async () => {
    const { runners, close } = await line(() => {});
    const outcome = await runners.run({ ...STEP, workItem: '1003', round: 2, deadlineSeconds: 60 });
    await close();
    expect(outcome).toMatchObject({
      kind: 'failed',
      job: 'coder-1003-2-1',
      reason: 'The agent pod succeeded without handing anything back.',
    });
  });
});

describe('a step’s attempts and results', () => {
  it('hands back an agent’s structured result as it came, and names each attempt’s job apart', async () => {
    const withResult = { ...DONE, result: { verdict: 'spec', scope: ['src/money.ts'] } };
    const { runners, handbackUrl, close } = await line((env) =>
      handBack(handbackUrl, env.ANTHROPIC_API_KEY ?? '', withResult).then(() => {}),
    );
    const first = await runners.run({ ...STEP, workItem: '1005', round: 1, attempt: 1, deadlineSeconds: 60 });
    const again = await runners.run({ ...STEP, workItem: '1005', round: 1, attempt: 2, deadlineSeconds: 60 });
    await close();
    expect(first).toEqual({ kind: 'handed-back', job: 'coder-1005-1-1', handback: withResult });
    expect(again).toMatchObject({ kind: 'handed-back', job: 'coder-1005-1-2' });
  });

  it('logs a handback with its work item and agent, from the job token', async () => {
    const logged: Record<string, unknown>[] = [];
    const log = pino({ level: 'info' }, { write: (line: string) => void logged.push(JSON.parse(line)) });
    const { runners, handbackUrl, close } = await line(
      (env) => handBack(handbackUrl, env.ANTHROPIC_API_KEY ?? '', DONE).then(() => {}),
      undefined,
      log,
    );
    await runners.run({ ...STEP, workItem: '1019', round: 1, deadlineSeconds: 60 });
    await close();
    const { job, workItem, agent, ending, patch } = logged.find((l) => l.msg === 'handed back') ?? {};
    expect({ job, workItem, agent, ending, patch }).toEqual({
      job: 'coder-1019-1-1',
      workItem: '1019',
      agent: 'coder',
      ending: 'finished',
      patch: DONE.patch.length,
    });
  });

  it('refuses a result over its limit', async () => {
    const { handbackUrl, close } = await line(() => {});
    const token = await issueJobToken(database.writer, { job: 'coder-1006-1-1', workItem: '1006', agent: 'coder' });
    const answer = await handBack(handbackUrl, token, { ...DONE, result: { text: 'x'.repeat(70_000) } });
    await close();
    expect(answer.status).toBe(400);
  });

  it('measures a result in bytes, as the runner does, and to the runner’s own bound', async () => {
    expect(RESULT_BYTES).toBe(RUNNER_RESULT_BYTES);
    const { handbackUrl, close } = await line(() => {});
    const token = await issueJobToken(database.writer, { job: 'coder-1008-1-1', workItem: '1008', agent: 'coder' });
    // Fewer characters than the bound, but more bytes: each is three in UTF-8.
    const answer = await handBack(handbackUrl, token, { ...DONE, result: { text: '€'.repeat(30_000) } });
    await close();
    expect(answer.status).toBe(400);
  });

  it('stops a step in hand when the line stops: its jobs go, and its token ends', async () => {
    let token = '';
    const { runners, calls, close } = await line((env) => {
      token = env.ANTHROPIC_API_KEY ?? '';
      // An agent still working, that would never hand back.
      return new Promise<void>(() => {});
    });
    const running = runners.run({ ...STEP, workItem: '1007', round: 1, deadlineSeconds: 60 });
    while (!token) await new Promise((resolve) => setTimeout(resolve, 5));
    await runners.cancel();
    const outcome = await running;
    await close();
    expect(outcome).toEqual({ kind: 'stopped', job: 'coder-1007-1-1' });
    expect(calls).toContain('DELETE /apis/batch/v1/namespaces/runners/jobs/coder-1007-1-1-agent');
    expect(await jobForToken(database.writer, token)).toBeUndefined();
  });

  it('stops a step when its signal aborts, and starts none whose signal aborted before it began', async () => {
    let token = '';
    const { runners, calls, close } = await line((env) => {
      token = env.ANTHROPIC_API_KEY ?? '';
      return new Promise<void>(() => {});
    });
    const before = new AbortController();
    before.abort();
    const step = { ...STEP, round: 1, deadlineSeconds: 60 };
    expect(await runners.run({ ...step, workItem: '1009', signal: before.signal })).toEqual({
      kind: 'stopped',
      job: 'coder-1009-1-1',
    });
    expect(calls.filter((call) => call.includes('1009'))).toEqual([]);

    const halt = new AbortController();
    const running = runners.run({ ...step, workItem: '1010', signal: halt.signal });
    while (!token) await new Promise((resolve) => setTimeout(resolve, 5));
    halt.abort();
    const outcome = await running;
    await close();
    expect(outcome).toEqual({ kind: 'stopped', job: 'coder-1010-1-1' });
    expect(calls).toContain('DELETE /apis/batch/v1/namespaces/runners/jobs/coder-1010-1-1-agent');
  });
});

describe('a step’s logs', () => {
  const kept = () => new StepLogs(database.writer, new DiskArtifacts(mkdtempSync(join(tmpdir(), 'step-logs-'))));
  const PREPARED = '{"msg":"installed the dependencies"}\n';
  const WORKED = '{"msg":"tool call","turn":1,"tool":"Read"}\n';
  const read = async (logs: StepLogs, workItem: string) =>
    Promise.all(
      (await logs.of(workItem)).map(async ({ job, part, ending, reason, hash, size }) => {
        const stream = await logs.open(hash);
        return { job, part, ending, reason, size, text: stream ? await text(stream) : null };
      }),
    );

  it('keeps both pods’ logs with a step that handed back, before its jobs are deleted', async () => {
    const logs = kept();
    const { runners, calls, handbackUrl, close } = await line(
      (env) => handBack(handbackUrl, env.ANTHROPIC_API_KEY ?? '', DONE).then(() => {}),
      undefined,
      quiet,
      { logs, podLogs: { prepare: PREPARED, agent: WORKED } },
    );
    await runners.run({ ...STEP, workItem: '1020', round: 1, deadlineSeconds: 60 });
    await close();
    expect(await read(logs, '1020')).toEqual([
      { job: 'coder-1020-1-1', part: 'prepare', ending: 'handed-back', reason: null, size: 37, text: PREPARED },
      { job: 'coder-1020-1-1', part: 'agent', ending: 'handed-back', reason: null, size: 43, text: WORKED },
    ]);
    const pods = calls.findIndex((c) => c.includes('/pods?labelSelector=factory.mrogan.dev%2Fjob%3Dcoder-1020-1-1'));
    const deleted = calls.findIndex((c) => c.startsWith('DELETE') && c.includes('-prepare'));
    expect(pods).toBeGreaterThan(-1);
    expect(pods).toBeLessThan(deleted);
    expect(calls).toContain('GET /api/v1/namespaces/runners/pods/coder-1020-1-1-agent-x7k2p/log?tailLines=2000');
  });

  it('keeps the prepare pod’s log when it fails, with the reason, and there is no agent pod to keep', async () => {
    const logs = kept();
    const failed = '{"level":"error","msg":"the prepare step failed","error":"Command failed: git fetch"}\n';
    const { runners, close } = await line(() => {}, 'failed', quiet, { logs, podLogs: { prepare: failed } });
    await runners.run({ ...STEP, workItem: '1021', round: 1, deadlineSeconds: 60 });
    await close();
    expect(await read(logs, '1021')).toEqual([
      expect.objectContaining({ part: 'prepare', ending: 'failed', reason: 'The prepare pod failed.', text: failed }),
    ]);
  });

  it('keeps the logs of a step the line stopped, before its jobs go', async () => {
    const logs = kept();
    let token = '';
    const { runners, close } = await line(
      (env) => {
        token = env.ANTHROPIC_API_KEY ?? '';
        return new Promise<void>(() => {});
      },
      undefined,
      quiet,
      { logs, podLogs: { prepare: PREPARED, agent: WORKED } },
    );
    const running = runners.run({ ...STEP, workItem: '1022', round: 1, deadlineSeconds: 60 });
    while (!token) await new Promise((resolve) => setTimeout(resolve, 5));
    await runners.cancel();
    expect(await running).toEqual({ kind: 'stopped', job: 'coder-1022-1-1' });
    await close();
    expect((await read(logs, '1022')).map(({ part, ending, text }) => ({ part, ending, text }))).toEqual([
      { part: 'prepare', ending: 'stopped', text: PREPARED },
      { part: 'agent', ending: 'stopped', text: WORKED },
    ]);
  });

  it('still deletes the jobs when a log cannot be read, and keeps the others', async () => {
    const logs = kept();
    const { runners, calls, close } = await line(() => {}, undefined, quiet, {
      logs,
      podLogs: { prepare: PREPARED, agent: 'refused' },
    });
    const outcome = await runners.run({ ...STEP, workItem: '1023', round: 1, deadlineSeconds: 60 });
    await close();
    expect(outcome).toMatchObject({ kind: 'failed' });
    expect((await read(logs, '1023')).map(({ part }) => part)).toEqual(['prepare']);
    expect(calls).toContain('DELETE /apis/batch/v1/namespaces/runners/jobs/coder-1023-1-1-agent');
  });

  it('goes on as ever when the store cannot keep a log: no table yet, or no volume', async () => {
    // Before migration 0017 has run, as when the factory's image is pinned before the console's, which migrates.
    const noTable = new StepLogs(database.writer, new DiskArtifacts(mkdtempSync(join(tmpdir(), 'step-logs-'))));
    noTable.keep = () => Promise.reject(new Error('relation "step_logs" does not exist'));
    // ARTIFACTS_DIR set, but no volume mounted there: the read-only root refuses the folder.
    const noVolume = new StepLogs(database.writer, new DiskArtifacts('/nonexistent/artifacts'));
    for (const [i, logs] of [noTable, noVolume].entries()) {
      const workItem = `${1030 + i}`;
      const warned: Record<string, unknown>[] = [];
      const log = pino({ level: 'warn' }, { write: (line: string) => void warned.push(JSON.parse(line)) });
      const { runners, calls, handbackUrl, close } = await line(
        (env) => handBack(handbackUrl, env.ANTHROPIC_API_KEY ?? '', DONE).then(() => {}),
        undefined,
        log,
        { logs, podLogs: { prepare: PREPARED, agent: WORKED } },
      );
      const outcome = await runners.run({ ...STEP, workItem, round: 1, deadlineSeconds: 60 });
      await close();
      expect(outcome).toEqual({ kind: 'handed-back', job: `coder-${workItem}-1-1`, handback: DONE });
      expect(calls).toContain(`DELETE /apis/batch/v1/namespaces/runners/jobs/coder-${workItem}-1-1-agent`);
      expect(warned.filter((w) => w.msg === 'could not keep a pod’s log')).toHaveLength(2);
    }
  });

  it('serves a work item’s kept logs as text on the step API, and none when it keeps none', async () => {
    const logs = kept();
    const { runners, handbackUrl, close } = await line(
      (env) => handBack(handbackUrl, env.ANTHROPIC_API_KEY ?? '', DONE).then(() => {}),
      undefined,
      quiet,
      { logs, podLogs: { prepare: PREPARED, agent: '{"msg":"cut mid-line"' } },
    );
    await runners.run({ ...STEP, workItem: '1026', round: 1, deadlineSeconds: 60 });
    await close();
    const github = {} as Parameters<typeof lineServers>[0]['github'];
    const serve = async (withLogs: boolean, path: string) => {
      const { api } = lineServers({ runners, github, log: quiet, ...(withLogs ? { logs } : {}) });
      await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
      try {
        const answer = await fetch(`http://127.0.0.1:${(api.address() as AddressInfo).port}${path}`);
        return { status: answer.status, type: answer.headers.get('content-type'), text: await answer.text() };
      } finally {
        await new Promise((resolve) => api.close(resolve));
      }
    };
    const served = await serve(true, '/v1/work-items/1026/logs');
    expect(served).toMatchObject({ status: 200, type: 'text/plain; charset=utf-8' });
    const lines = served.text.split('\n');
    expect(lines[0]).toMatch(/^== coder-1026-1-1 prepare \(coder-1026-1-1-prepare-x7k2p\), handed-back, \d{4}-/);
    expect(lines[1]).toBe('{"msg":"installed the dependencies"}');
    expect(lines[2]).toMatch(/^== coder-1026-1-1 agent /);
    expect(lines.slice(3)).toEqual(['{"msg":"cut mid-line"', '']);
    expect((await serve(true, '/v1/work-items/9999/logs')).text).toBe("No runner's log is kept for 9999.\n");
    expect((await serve(false, '/v1/work-items/1026/logs')).status).toBe(404);
  });

  it('stops a step’s agent even when its log never comes', async () => {
    let token = '';
    const { runners, calls, close } = await line(
      (env) => {
        token = env.ANTHROPIC_API_KEY ?? '';
        return new Promise<void>(() => {});
      },
      undefined,
      quiet,
      { logs: kept(), podLogs: { agent: WORKED }, hang: true },
    );
    const running = runners.run({ ...STEP, workItem: '1024', round: 1, deadlineSeconds: 60 });
    while (!token) await new Promise((resolve) => setTimeout(resolve, 5));
    await runners.cancel();
    // Its token ended before its logs were waited for, and its jobs went after.
    expect(await jobForToken(database.writer, token)).toBeUndefined();
    expect(calls).toContain('DELETE /apis/batch/v1/namespaces/runners/jobs/coder-1024-1-1-agent');
    expect(await running).toEqual({ kind: 'stopped', job: 'coder-1024-1-1' });
    await close();
  });
});

describe('the handback', () => {
  it('turns away a job nobody waits for, and a body over its limit', async () => {
    const { handbackUrl, close } = await line(() => {});
    const token = await issueJobToken(database.writer, { job: 'coder-1004-1-1', workItem: '1004', agent: 'coder' });
    expect((await handBack(handbackUrl, token, DONE)).status).toBe(409);
    const huge = await fetch(handbackUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: 'x'.repeat(3 * 1024 * 1024),
    });
    expect(huge.status).toBe(413);
    await close();
  });
});

describe('the scope fence, against a path that climbs out', () => {
  it('refuses it before it can match a folder', () => {
    const climbing = PATCH('src/../.github/workflows/x.yml');
    expect(() => fence(climbing, ['src/'])).toThrow('not a plain path');
  });
});
