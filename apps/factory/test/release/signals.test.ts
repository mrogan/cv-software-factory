/**
 * A rollback as signals: which runs send one, under which symptom class and route, and the name each goes in the
 * inbox under. The I/O around it is the line's (`test/line/release.test.ts`).
 */
import { cutTo } from '@software-factory/events';
import { validateSignal } from '@software-factory/events/schemas';
import { describe, expect, it } from 'vitest';
import { recordedFrom } from '../../src/release/recorded.ts';
import { observe } from '../../src/release/rollout.ts';
import { canarySignal, failedMeasures, JOURNEY_FALLBACK } from '../../src/release/signals.ts';
import { CANARY, commitOf, digestOf, releaseOf, rollout, run, STABLE } from './fixtures.ts';

const T0 = '2026-10-11T09:00:00Z';
const FAILED_AT = '2026-10-11T09:03:00Z';

/** The release, as the line recorded it starting: watched, or found live. */
const recorded = (release = releaseOf(CANARY), watched = true) =>
  recordedFrom([
    {
      work_item: '1290',
      ts: T0,
      type: 'release.started',
      payload: {
        release,
        version: commitOf(CANARY),
        previous: commitOf(STABLE),
        commit: commitOf(CANARY),
        image: { digest: digestOf(CANARY), signed: true, admitted: true },
        watched,
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

  it('are only of a release the line watched start: an older run, or a found-live release’s, was before it', () => {
    const older = run({ hash: 'oldrelease1', created: T0, completed: FAILED_AT, phase: 'Failed' });
    expect(failedMeasures(observe(aborted, [older]), recorded())).toEqual([]);
    // A run of an earlier release of the same version, at an earlier revision, is that release's.
    const earlier = run({
      revision: 2,
      created: T0,
      completed: FAILED_AT,
      phase: 'Failed',
      metrics: { errors: { phase: 'Failed', value: '[0.0119]' } },
    });
    expect(failedMeasures(observe(aborted, [earlier]), recorded())).toEqual([]);
    // A release recorded by its hash alone, before releases were named by revision, has every run of its hash.
    expect(failedMeasures(observe(aborted, [earlier]), recorded(CANARY))).toHaveLength(1);
    // A release found live was out before the line watched: a run that failed an earlier attempt of it was too.
    const live = rollout({ current: CANARY, stable: CANARY });
    expect(failedMeasures(observe(live, [failed]), recorded(releaseOf(CANARY), false))).toEqual([]);
    expect(failedMeasures(observe(live, [failed]), recorded(releaseOf(CANARY), true))).toHaveLength(3);
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
        release: releaseOf(CANARY),
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

  it('name a failed journey by its check’s class and route, every route for many, or a fixed class when it is lost', () => {
    const journeys = failedMeasures(observe(aborted, [failed]), recorded())[2];
    if (!journeys) throw new Error('the journeys failed');
    const regressions = [
      { sense: 'probe' as const, check: 'checkout/console', route: '/checkout', symptom: 'browser-error' as const },
      { sense: 'crawler' as const, check: 'links', route: '/about', message: 'A link leads nowhere' },
    ];
    const one = canarySignal(journeys, { journeys: regressions.slice(0, 1) });
    expect(one.signal).toMatchObject({ check: 'journeys', route: '/checkout', symptom: 'browser-error' });
    const read = canarySignal(journeys, { journeys: regressions });
    expect(read.signal).toMatchObject({ check: 'journeys', route: '*', symptom: 'browser-error' });
    expect(read.signal.evidence?.[0]).toMatchObject({ kind: 'canary', checks: regressions });
    expect(validateSignal(read.signal)).toEqual({ ok: true });

    const lost = canarySignal(journeys, {});
    expect(lost.signal).toMatchObject({ check: 'journeys', route: '*', symptom: JOURNEY_FALLBACK });
    expect(lost.signal.evidence?.[0]).not.toHaveProperty('checks');
    expect(validateSignal(lost.signal)).toEqual({ ok: true });
  });

  it('come from what the analysis judged bad in a canary Martin rolled back, in its words, and not from one stopped', () => {
    const verdict = 'Metric "errors" assessed Inconclusive due to inconclusive (1) > inconclusiveLimit (0)';
    const judged = run({
      step: 2,
      created: T0,
      completed: FAILED_AT,
      phase: 'Inconclusive',
      message: verdict,
      metrics: { errors: { phase: 'Inconclusive', value: '[0.0213,0.0213]', inconclusive: 1 } },
    });
    const ending = (type: string, payload: object) => ({
      work_item: '1290',
      ts: '2026-10-11T09:05:00Z',
      type,
      payload: { release: releaseOf(CANARY), version: commitOf(CANARY), restored: commitOf(STABLE), ...payload },
    });
    const started = [...(recorded().get(releaseOf(CANARY))?.values() ?? [])][0]?.started;
    const startedRow = { work_item: '1290', ts: T0, type: 'release.started', payload: started };
    const at = { abortedAt: '2026-10-11T09:04:00Z' };
    const byMartin = recordedFrom([startedRow, ending('release.rolled-back', { by: 'martin', ...at })]);
    const [errors, ...more] = failedMeasures(observe(aborted, [judged]), byMartin);
    expect(more).toEqual([]);
    if (!errors) throw new Error('the errors were judged bad');
    const { signal } = canarySignal(errors, {});
    expect(signal).toMatchObject({ check: 'errors', symptom: 'server-error', route: '*' });
    expect(signal.summary).toBe(
      cutTo(
        `${commitOf(CANARY).slice(0, 7)} did worse than ${commitOf(STABLE).slice(0, 7)} on errors, judged bad and rolled back by Martin: ${verdict}`,
        200,
      ),
    );
    // The analysis's verdict, verbatim, with the measure as it judged it.
    expect(signal.evidence?.[0]).toMatchObject({
      measure: { name: 'errors', phase: 'inconclusive', value: 0.0213, limit: 0.01, message: verdict },
    });
    expect(validateSignal(signal)).toEqual({ ok: true });
    // Stopped with the line, promoted fully, or not ended yet: what it judged bad sends nothing.
    const byStop = recordedFrom([startedRow, ending('release.aborted', { by: 'stop', ...at })]);
    expect(failedMeasures(observe(aborted, [judged]), byStop)).toEqual([]);
    const promoted = recordedFrom([
      startedRow,
      ending('release.promoted', { previous: commitOf(STABLE), watched: true, dryRun: false }),
    ]);
    expect(failedMeasures(observe(rollout({ current: CANARY, stable: CANARY }), [judged]), promoted)).toEqual([]);
    expect(failedMeasures(observe(aborted, [judged]), recorded())).toEqual([]);
    // Martin's rollback of a later attempt says nothing of a run an earlier attempt's abort ended.
    const later = recordedFrom([
      startedRow,
      ending('release.aborted', { by: 'martin', ...at }),
      { ...startedRow, ts: '2026-10-11T09:10:00Z' },
      ending('release.rolled-back', { by: 'martin', abortedAt: '2026-10-11T09:20:00Z' }),
    ]);
    expect(failedMeasures(observe(aborted, [judged]), later)).toEqual([]);
  });

  it('are named by the run and the measure, so sending one again is the same signal, whatever was read', () => {
    const [errors, latency] = failedMeasures(observe(aborted, [failed]), recorded());
    if (!errors || !latency) throw new Error('two failed measures');
    // Read again after a restart, it is the same.
    const again = failedMeasures(observe(aborted, [structuredClone(failed)]), recorded())[0];
    if (!again) throw new Error('read again');
    expect(canarySignal(again, {}).id).toBe(canarySignal(errors, {}).id);
    // Read again when Prometheus says something else: still the same, so triage takes it once.
    const routes = { unit: '%', worse: [{ route: '/search', canary: 15, baseline: 0.5 }] };
    expect(canarySignal(again, { routes }).id).toBe(canarySignal(errors, {}).id);
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
