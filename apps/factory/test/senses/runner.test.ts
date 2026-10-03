import type { Evidence, InboxSignal } from '@software-factory/events';
import { validateSignal } from '@software-factory/events/schemas';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SenseRunner } from '../../src/senses/runner.ts';
import type { Finding, Observation, Sense } from '../../src/senses/types.ts';

const V1 = 'a'.repeat(40);
const V2 = 'b'.repeat(40);
const MINUTE = 60_000;

const broken: Finding = { symptom: 'wrong-result', message: 'It was wrong.' };

/** A sense that answers each pass with the next of the results it was given, naming the check `one`. */
function scripted(...results: Array<Finding | null | 'trouble'>) {
  const passes: string[] = [];
  const sense: Sense = {
    name: 'probe',
    async pass(version) {
      passes.push(version);
      const next = results.shift() ?? null;
      const observation: Observation = {
        check: 'one',
        route: '/things',
        finding: next === 'trouble' ? null : next,
        artifacts: [],
        ...(next === 'trouble' && { trouble: 'the app did not answer' }),
      };
      return [observation];
    },
  };
  return { sense, passes };
}

/** A runner with a clock and a version that the test moves, and an inbox that is a list. */
function setup(sense: Sense, options: { every?: number } = {}) {
  const state = { now: Date.parse('2026-10-03T12:00:00Z'), version: V1 };
  const sent: InboxSignal[] = [];
  const runner = new SenseRunner({
    sense,
    version: async () => state.version,
    send: async (signal) => void sent.push(signal),
    log: pino({ level: 'silent' }),
    now: () => state.now,
    ...options,
  });
  /** Moves the clock on, then looks. */
  const after = async (ms: number) => {
    state.now += ms;
    return runner.tick();
  };
  return { runner, state, sent, after };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('a check that fails', () => {
  it('opens nothing the first time, and signals the second time in a row', async () => {
    const { sense } = scripted(broken, broken);
    const { runner, sent, after } = setup(sense);
    await runner.tick();
    expect(sent).toEqual([]);
    await after(5 * MINUTE);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      sense: 'probe',
      check: 'one',
      route: '/things',
      version: V1,
      symptom: 'wrong-result',
      observedAt: '2026-10-03T12:05:00.000Z',
      artifacts: [],
    });
    expect(validateSignal(sent[0])).toEqual({ ok: true });
  });

  it('signals again each run it goes on failing, for the inbox to count', async () => {
    const { sense } = scripted(broken, broken, broken);
    const { runner, sent, after } = setup(sense);
    await runner.tick();
    await after(5 * MINUTE);
    await after(5 * MINUTE);
    expect(sent).toHaveLength(2);
  });

  it('starts again at one when it fails in another way', async () => {
    const other: Finding = { symptom: 'server-error', message: 'It fell over.' };
    const { sense } = scripted(broken, other, other);
    const { runner, sent, after } = setup(sense);
    await runner.tick();
    await after(5 * MINUTE);
    expect(sent).toEqual([]);
    await after(5 * MINUTE);
    expect(sent.map((s) => s.symptom)).toEqual(['server-error']);
  });

  it('carries the evidence it found, and no more than a signal may', async () => {
    const http: Evidence = {
      kind: 'http',
      method: 'GET',
      url: '/x',
      status: 500,
      headers: {},
      timings: { firstByteMs: 1, totalMs: 2 },
      redirects: [],
    };
    const evidence = Array.from({ length: 10 }, () => http);
    const { sense } = scripted({ ...broken, evidence }, { ...broken, evidence });
    const { runner, sent, after } = setup(sense);
    await runner.tick();
    await after(5 * MINUTE);
    expect(sent[0]?.evidence).toHaveLength(8);
    expect(validateSignal(sent[0])).toEqual({ ok: true });
  });
});

describe('a check that passes', () => {
  it('writes nothing, and ends the streak', async () => {
    const { sense } = scripted(broken, null, broken);
    const { runner, sent, after } = setup(sense);
    await runner.tick();
    await after(5 * MINUTE);
    await after(5 * MINUTE);
    expect(sent).toEqual([]);
  });
});

describe('a check that could not tell', () => {
  it('is neither a pass nor a failure: the streak waits', async () => {
    const { sense } = scripted(broken, 'trouble', broken);
    const { runner, sent, after } = setup(sense);
    await runner.tick();
    await after(5 * MINUTE);
    expect(sent).toEqual([]);
    await after(5 * MINUTE);
    expect(sent).toHaveLength(1);
  });
});

describe('when it runs', () => {
  it('runs at once the first time, then every interval, and not between', async () => {
    const { sense, passes } = scripted();
    const { runner, after } = setup(sense, { every: 5 * MINUTE });
    expect((await runner.tick())?.reason).toBe('first run');
    expect(await after(4 * MINUTE)).toBeNull();
    expect((await after(MINUTE))?.reason).toBe('schedule');
    expect(passes).toHaveLength(2);
  });

  it('runs at once when the app’s version changes, whatever the interval', async () => {
    const { sense, passes } = scripted();
    const { runner, state, after } = setup(sense, { every: 5 * MINUTE });
    await runner.tick();
    state.version = V2;
    const run = await after(15_000);
    expect(run).toMatchObject({ reason: 'new version', version: V2 });
    expect(passes).toEqual([V1, V2]);
    expect(await after(15_000)).toBeNull();
  });

  it('puts the new version on the signals it sends', async () => {
    const { sense } = scripted(broken, broken);
    const { runner, state, sent, after } = setup(sense);
    await runner.tick();
    state.version = V2;
    await after(15_000);
    expect(sent.map((s) => s.version)).toEqual([V2]);
  });

  it('does not look while a run is going: never two at once', async () => {
    let release: () => void = () => {};
    const passes: string[] = [];
    const sense: Sense = {
      name: 'probe',
      pass: async (version) => {
        passes.push(version);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return [];
      },
    };
    const { runner } = setup(sense);
    const first = runner.tick();
    await vi.waitFor(() => expect(passes).toHaveLength(1));
    expect(await runner.tick()).toBeNull();
    expect(await runner.run(V2, 'new version')).toBeNull();
    expect(passes).toHaveLength(1);
    release();
    expect((await first)?.version).toBe(V1);
  });

  it('throws away a run that the app changed under, and runs again', async () => {
    const { sense, passes } = scripted(broken, broken, broken);
    const { runner, state, sent, after } = setup(sense);
    const original = sense.pass.bind(sense);
    sense.pass = async (version) => {
      const observations = await original(version);
      state.version = V2; // the app is replaced while the sense is looking
      return observations;
    };
    expect(await runner.tick()).toBeNull();
    sense.pass = original;
    const again = await after(15_000);
    expect(again).toMatchObject({ reason: 'new version', version: V2 });
    expect(passes).toEqual([V1, V2]);
    // The dropped run counted for nothing: this is the first failure on the new version.
    expect(sent).toEqual([]);
  });

  it('carries on when the app does not report its version, or the inbox is down', async () => {
    const { sense } = scripted(broken, broken, broken);
    const state = { fail: true };
    const sent: InboxSignal[] = [];
    const runner = new SenseRunner({
      sense,
      version: async () => {
        if (state.fail) throw new Error('down');
        return V1;
      },
      send: async () => {
        if (sent.length === 0) {
          sent.push({} as InboxSignal);
          throw new Error('inbox down');
        }
      },
      log: pino({ level: 'silent' }),
      every: 0.001,
    });
    expect(await runner.tick()).toBeNull();
    state.fail = false;
    await runner.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await runner.tick()).toMatchObject({ failed: 1, signalled: 0 });
  });
});

describe('start', () => {
  it('looks at the version on a timer until stopped', async () => {
    vi.useFakeTimers();
    const { sense, passes } = scripted();
    const state = { now: 0 };
    const runner = new SenseRunner({
      sense,
      version: async () => V1,
      send: async () => {},
      log: pino({ level: 'silent' }),
      now: () => state.now,
      every: 60_000,
    });
    const stop = runner.start(15_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(passes).toHaveLength(1);
    state.now = 60_000;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(passes).toHaveLength(2);
    await stop();
    state.now = 200_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(passes).toHaveLength(2);
  });
});
