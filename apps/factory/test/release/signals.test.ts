/**
 * A rollback as signals: which runs send one, under which symptom class and route, and the name each goes in the
 * inbox under. The I/O around it is the line's (`test/line/release.test.ts`).
 */
import { validateSignal } from '@software-factory/events/schemas';
import { describe, expect, it } from 'vitest';
import { canarySignal, failedMeasures, JOURNEY_FALLBACK } from '../../src/release/signals.ts';
import { observe, recordedFrom } from '../../src/release/watch.ts';
import { CANARY, commitOf, digestOf, rollout, run, STABLE } from './fixtures.ts';

const T0 = '2026-10-11T09:00:00Z';
const FAILED_AT = '2026-10-11T09:03:00Z';

/** The release, as the line recorded it starting. */
const recorded = (release = CANARY) =>
  recordedFrom([
    {
      work_item: '1290',
      ts: T0,
      type: 'release.started',
      payload: {
        release,
        version: commitOf(release),
        previous: commitOf(STABLE),
        commit: commitOf(release),
        image: { digest: digestOf(release), signed: true, admitted: true },
        watched: true,
        dryRun: false,
      },
    },
  ]);

const aborted = rollout({ current: CANARY, stable: STABLE, stepIndex: 1, abort: true });

/** The background run, failed on latency and errors, with its journeys failed too. */
const failed = run({
  created: T0,
  completed: FAILED_AT,
  phase: 'Failed',
  message: 'Metric "latency" assessed Failed due to failed (2) > failureLimit (1)',
  metrics: {
    errors: { phase: 'Failed', value: '[0.0119]', message: 'Metric "errors" assessed Failed' },
    latency: { phase: 'Failed', value: '[0.247]' },
    journeys: { phase: 'Failed' },
  },
});

describe('a rollback’s signals', () => {
  it('come from a run whose phase is Failed: an abort terminates the runs, which fails none, and sends nothing', () => {
    // Martin's abort: the Rollout is aborted as a failed analysis leaves it, and its runs are terminated, successful.
    const terminated = run({ created: T0, completed: FAILED_AT, phase: 'Successful', terminate: true });
    expect(failedMeasures(observe(aborted, [terminated]), recorded())).toEqual([]);
    // A run that could not judge says nothing of the canary either.
    const error = run({ created: T0, completed: FAILED_AT, phase: 'Error', metrics: { errors: { phase: 'Error' } } });
    expect(failedMeasures(observe(aborted, [error]), recorded())).toEqual([]);
  });

  it('are one for each failed measure that stands for a symptom: too few requests says nothing of the canary', () => {
    const step = run({
      step: 2,
      created: T0,
      completed: FAILED_AT,
      phase: 'Failed',
      metrics: { 'enough-requests': { phase: 'Failed', value: '[40]' } },
    });
    const measures = failedMeasures(observe(aborted, [failed, step]), recorded());
    expect(measures.map((m) => `${m.run.metadata.name} ${m.measure.name}`)).toEqual([
      `website-${CANARY}-4 errors`,
      `website-${CANARY}-4 latency`,
      `website-${CANARY}-4 journeys`,
    ]);
  });

  it('are only of a release the line recorded starting: an older run in the cluster was before it watched', () => {
    const older = run({ hash: 'oldrelease1', created: T0, completed: FAILED_AT, phase: 'Failed' });
    expect(failedMeasures(observe(aborted, [older]), recorded())).toEqual([]);
  });

  it('name the symptom class each measure stands for, on the one route where the canary did worse, or every route', () => {
    const [errors, latency] = failedMeasures(observe(aborted, [failed]), recorded());
    if (!errors || !latency) throw new Error('two failed measures');
    const routes = (...worse: string[]) => ({
      unit: 'ms',
      worse: worse.map((route) => ({ route, canary: 380, baseline: 120 })),
    });

    const one = canarySignal(latency, { routes: routes('/search') });
    expect(one.signal).toMatchObject({
      sense: 'canary',
      check: 'latency',
      route: '/search',
      symptom: 'slow-response',
      version: commitOf(CANARY),
      observedAt: '2026-10-11T09:03:00.000Z',
    });
    expect(one.signal.evidence).toEqual([
      {
        kind: 'canary',
        release: CANARY,
        version: commitOf(CANARY),
        against: commitOf(STABLE),
        measure: { name: 'latency', phase: 'failed', value: 0.247, limit: 0 },
        routes: routes('/search'),
      },
    ]);
    expect(validateSignal(one.signal)).toEqual({ ok: true });

    const many = canarySignal(errors, { routes: routes('/search', '/products/:slug') });
    expect(many.signal).toMatchObject({ route: '*', symptom: 'server-error' });
    expect(many.signal.summary).toBe(
      `${commitOf(CANARY).slice(0, 7)} did worse than ${commitOf(STABLE).slice(0, 7)} on errors: Metric "errors" assessed Failed`,
    );
    expect(canarySignal(errors, {}).signal.route).toBe('*');
    expect(validateSignal(many.signal)).toEqual({ ok: true });
  });

  it('name a failed journey by its own check’s class and route, or by a fixed class on every route when it is lost', () => {
    const journeys = failedMeasures(observe(aborted, [failed]), recorded())[2];
    if (!journeys) throw new Error('the journeys failed');
    const regressions = [
      { sense: 'probe' as const, check: 'checkout/console', route: '/checkout', symptom: 'browser-error' as const },
      { sense: 'crawler' as const, check: 'links', route: '/about', message: 'A link leads nowhere' },
    ];
    const read = canarySignal(journeys, { journeys: regressions });
    expect(read.signal).toMatchObject({ check: 'journeys', route: '/checkout', symptom: 'browser-error' });
    expect(read.signal.evidence?.[0]).toMatchObject({ kind: 'canary', checks: regressions });
    expect(validateSignal(read.signal)).toEqual({ ok: true });

    const lost = canarySignal(journeys, {});
    expect(lost.signal).toMatchObject({ check: 'journeys', route: '*', symptom: JOURNEY_FALLBACK });
    expect(lost.signal.evidence?.[0]).not.toHaveProperty('checks');
    expect(validateSignal(lost.signal)).toEqual({ ok: true });
  });

  it('are named by the run, the measure and the route, so sending one again is the same signal', () => {
    const [errors, latency] = failedMeasures(observe(aborted, [failed]), recorded());
    if (!errors || !latency) throw new Error('two failed measures');
    // Read again after a restart, it is the same.
    const again = failedMeasures(observe(aborted, [structuredClone(failed)]), recorded())[0];
    if (!again) throw new Error('read again');
    expect(canarySignal(again, {}).id).toBe(canarySignal(errors, {}).id);
    expect(canarySignal(latency, {}).id).not.toBe(canarySignal(errors, {}).id);
    const another = run({
      uid: 'another-run',
      created: T0,
      completed: FAILED_AT,
      phase: 'Failed',
      metrics: { errors: { phase: 'Failed' } },
    });
    const [ofAnother] = failedMeasures(observe(aborted, [another]), recorded());
    expect(ofAnother && canarySignal(ofAnother, {}).id).not.toBe(canarySignal(errors, {}).id);
  });
});
