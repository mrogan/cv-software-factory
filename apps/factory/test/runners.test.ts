import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { issueJobToken, jobForToken } from '@software-factory/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../packages/store/test/database.ts';
import { type Handback, RESULT_BYTES as RUNNER_RESULT_BYTES, type Step } from '../../runner/src/step.ts';
import { agentJob, prepareJob } from '../src/runners/jobs.ts';
import type { Kube } from '../src/runners/kube.ts';
import { fence, ownedPaths } from '../src/runners/scope.ts';
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
    expect(job.spec).toMatchObject({ backoffLimit: 0, activeDeadlineSeconds: 600 });
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

/** The Kubernetes API, as far as the line uses it: Jobs that end as each test says, and a record of every call. */
function fakeKube(
  agent: (env: Record<string, string>) => void | Promise<void>,
  prepare: 'succeeded' | 'failed' = 'succeeded',
) {
  const calls: string[] = [];
  const jobs = new Map<string, { status: Record<string, unknown> }>();
  const kube: Kube = {
    async get<T>(path: string) {
      calls.push(`GET ${path}`);
      return jobs.get(path.split('/').at(-1) ?? '') as T | undefined;
    },
    async create(path: string, body: unknown) {
      const manifest = body as {
        kind: string;
        metadata: { name: string };
        spec: { template?: { spec: { containers: { env: { name: string; value: string }[] }[] } } };
      };
      calls.push(`POST ${path} ${manifest.kind} ${manifest.metadata.name}`);
      if (manifest.kind !== 'Job') return;
      const name = manifest.metadata.name;
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
      jobs.delete(path.split('/').at(-1) ?? '');
    },
  };
  return { kube, calls };
}

let database: Database;
beforeAll(async () => {
  database = await freshDatabase('runners');
});
afterAll(() => database?.end());

async function line(agent: Parameters<typeof fakeKube>[0], prepare?: 'succeeded' | 'failed') {
  const { kube, calls } = fakeKube(agent, prepare);
  let handbackUrl = '';
  const runners = new Runners({
    sql: database.writer,
    kube,
    image: 'runner',
    gatewayUrl: 'http://gateway',
    handbackUrl: 'http://line/v1/handback',
    log: quiet,
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
