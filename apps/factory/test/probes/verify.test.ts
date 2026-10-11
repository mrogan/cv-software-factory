/**
 * A ticket's check run again for Verify: as often as it takes to pass or fail twice in a row, and served to the line
 * beside the page reader. The senses are stood in for: what they see is the test's.
 */
import type { Evidence } from '@software-factory/events';
import { DiskArtifacts } from '@software-factory/store';
import { describe, expect, it } from 'vitest';
import type { Seen } from '../../src/gates/journeys.ts';
import { readerServer } from '../../src/probes/reader.ts';
import { type ObserveStable, oneAtATime, type VerifyAnswer, verifyCheck } from '../../src/probes/verify.ts';

const VERSION = 'b'.repeat(40);
const request = { sense: 'probe', check: 'departments/redirect-loop', route: '/departments/:department' } as const;
const http: Evidence = {
  kind: 'http',
  method: 'GET',
  url: '/departments/garden',
  status: null,
  headers: {},
  timings: { firstByteMs: 3, totalMs: 40 },
  redirects: [{ status: 302, location: '/departments/garden' }],
};

/** The senses, seeing each run in turn what the test lists: a pass, a failure, trouble, or a new version. */
function senses(...runs: ('pass' | 'fail' | 'trouble' | 'moved' | 'missing')[]) {
  const asked: (readonly Pick<Seen, 'sense' | 'check'>[])[] = [];
  const observe: ObserveStable = async (only) => {
    asked.push(only);
    const run = runs.shift() ?? 'pass';
    const seen: Seen = {
      sense: 'probe',
      check: request.check,
      route: '/departments/garden',
      failed: run === 'fail',
      ...(run === 'trouble' ? { trouble: 'The page did not load in time' } : {}),
      ...(run === 'fail' ? { message: 'The page redirected to itself', evidence: [http] } : {}),
    };
    return {
      version: run === 'moved' ? 'c'.repeat(40) : VERSION,
      seen: run === 'missing' ? [] : [seen, { ...seen, check: 'departments/console', failed: true }],
    };
  };
  return { observe, asked };
}

describe('a check run again for Verify', () => {
  it('clears a check that passes twice in a row, running only its probe', async () => {
    const { observe, asked } = senses('pass', 'pass');
    expect(await verifyCheck(observe, request)).toEqual({
      outcome: 'cleared',
      version: VERSION,
      runs: ['passed', 'passed'],
    });
    expect(asked).toEqual([[{ sense: 'probe', check: request.check }], [{ sense: 'probe', check: request.check }]]);
  });

  it('says it persists when it fails twice in a row, with the proof of the last', async () => {
    const { observe } = senses('pass', 'fail', 'fail');
    expect(await verifyCheck(observe, request)).toEqual({
      outcome: 'persists',
      version: VERSION,
      runs: ['passed', 'failed', 'failed'],
      message: 'The page redirected to itself',
      evidence: http,
    });
  });

  it('cannot tell when it never passes or fails twice in a row, nor when a run cannot finish', async () => {
    const flapping = await verifyCheck(senses('pass', 'fail', 'pass', 'fail', 'pass').observe, request);
    expect(flapping).toMatchObject({ outcome: 'unsure', runs: ['passed', 'failed', 'passed', 'failed'] });
    // A run that could not finish is not a pass: a check that cannot see its page never clears.
    const trouble = await verifyCheck(senses('pass', 'trouble').observe, request);
    expect(trouble).toEqual({
      outcome: 'unsure',
      version: VERSION,
      runs: ['passed', 'unsure'],
      message: 'The page did not load in time',
    });
    expect(await verifyCheck(senses('missing').observe, request)).toMatchObject({ outcome: 'unsure' });
  });

  it('cannot tell when the app moves to another version between runs', async () => {
    const moved = await verifyCheck(senses('pass', 'moved').observe, request);
    expect(moved).toEqual({
      outcome: 'unsure',
      version: VERSION,
      runs: ['passed', 'unsure'],
      message: `The app moved to ${'c'.repeat(40)}`,
    });
  });

  it('runs one verification at a time', async () => {
    let running = 0;
    let most = 0;
    const one = oneAtATime(async (n: number) => {
      most = Math.max(most, ++running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      if (n === 2) throw new Error('This one fails');
      return n;
    });
    const results = await Promise.allSettled([one(1), one(2), one(3)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(most).toBe(1);
  });
});

describe('the probes worker’s verification endpoint', () => {
  const answer: VerifyAnswer = { outcome: 'cleared', version: VERSION, runs: ['passed', 'passed'] };
  const store = new DiskArtifacts('/nonexistent');
  const log = { info: () => {}, warn: () => {} };
  const sense = {
    withPage: async () => {
      throw new Error('The page reader is not asked');
    },
  };

  async function serve(verify?: (asked: typeof request) => Promise<VerifyAnswer>) {
    const asked: unknown[] = [];
    const server = readerServer({
      app: 'http://website.test',
      sense,
      store,
      version: async () => VERSION,
      log,
      ...(verify
        ? {
            verify: async (r) => {
              asked.push(r);
              return verify(r as typeof request);
            },
          }
        : {}),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const post = (body: string) => fetch(`${base}/v1/verify`, { method: 'POST', body });
    return { post, asked, close: () => new Promise((resolve) => server.close(resolve)) };
  }

  it('runs the check it is asked for, and answers what the runs saw', async () => {
    const { post, asked, close } = await serve(async () => answer);
    try {
      const response = await post(JSON.stringify(request));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(answer);
      expect(asked).toEqual([request]);
    } finally {
      await close();
    }
  });

  it('refuses a body that is not a verification, and says when the check could not run', async () => {
    const { post, asked, close } = await serve(async () => {
      throw new Error('Chromium would not start');
    });
    try {
      for (const body of ['not json', JSON.stringify({ ...request, sense: 'logs' }), JSON.stringify({ check: 'x' })]) {
        expect((await post(body)).status).toBe(400);
      }
      expect(asked).toEqual([]);
      const failed = await post(JSON.stringify(request));
      expect(failed.status).toBe(502);
      expect(await failed.json()).toEqual({ error: 'the check could not be run' });
    } finally {
      await close();
    }
  });

  it('is not served by a worker that verifies nothing', async () => {
    const { post, close } = await serve();
    try {
      expect((await post(JSON.stringify(request))).status).toBe(404);
    } finally {
      await close();
    }
  });
});
