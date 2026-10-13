import type { PayloadOf } from '@software-factory/events';
import { validate } from '@software-factory/events/schemas';
import { describe, expect, it } from 'vitest';
import type { Draft } from '../../src/line/gates.ts';
import { asEvent } from '../../src/line/gates.ts';
import { type AnalysisRun, hashesOf, type Rollout } from '../../src/release/read.ts';
import {
  dryRunEvents,
  dryRunRelease,
  type Facts,
  observe,
  planOf,
  recordedFrom,
  releaseEvents,
  releaseNeeds,
  type Series,
  type Start,
  secondsOf,
  type Target,
} from '../../src/release/watch.ts';
import { ABORTED_AT, CANARY, commitOf, digestOf, releaseOf, rollout, run, STABLE } from './fixtures.ts';

/**
 * A store of release events, as the line keeps it: each pass appends what `releaseEvents` drafts, and the next pass
 * reads it back. Starting the line again is a pass over the same store. A pass is a few seconds after the latest
 * thing its runs say happened, as the line would see it.
 */
function store(seed: { target: Target; type: string; payload: unknown }[] = []) {
  const log = seed.map(({ target, type, payload }) => ({ work_item: target, ts: t(-60), type, payload }));
  return {
    log,
    /** One pass over the Rollout and its runs; returns what it appended, by target, as `[type, summary]`. */
    pass(r: Rollout, runs: AnalysisRun[], read: Partial<Facts> & { start?: Start } = {}) {
      const o = observe(r, runs);
      const recorded = recordedFrom(log);
      const needs = releaseNeeds(o, recorded);
      const facts: Facts = { figures: new Map(), series: new Map(), ...read };
      const drafts = releaseEvents(o, recorded, facts);
      const times = runs.flatMap((r) => [r.metadata.creationTimestamp, r.status.completedAt ?? '']).map(Date.parse);
      const ts = new Date(Math.max(Date.parse(t(-60)), ...times.filter(Number.isFinite)) + 5_000).toISOString();
      for (const [target, list] of drafts) {
        for (const draft of list) {
          // Every draft is an event the store would take.
          const event = asEvent(target, draft, ts);
          expect(validate(event)).toEqual({ ok: true });
          log.push({ work_item: target, ts, type: draft.type, payload: draft.payload });
        }
      }
      return { needs, drafts, said: said(drafts) };
    },
    of(target: Target, type: string) {
      return log.filter((e) => e.work_item === target && e.type === type).map((e) => e.payload);
    },
  };
}

const said = (drafts: Map<Target, Draft[]>) =>
  Object.fromEntries([...drafts].map(([target, list]) => [String(target), list.map((d) => d.type)]));

/** The stable version as the line recorded it, on the line: the version a release replaces. */
const STABLE_RECORDED = [
  {
    target: null,
    type: 'release.started',
    payload: {
      release: releaseOf(STABLE),
      version: commitOf(STABLE),
      previous: commitOf(STABLE),
      commit: commitOf(STABLE),
      image: { digest: digestOf(STABLE), signed: true, admitted: true },
      watched: false,
      steps: null,
      dryRun: false,
    },
  },
  {
    target: null,
    type: 'release.promoted',
    payload: {
      release: releaseOf(STABLE),
      version: commitOf(STABLE),
      previous: commitOf(STABLE),
      commit: commitOf(STABLE),
      watched: false,
      dryRun: false,
    },
  },
];

const START: Start = { commit: commitOf(CANARY), signed: true, carries: ['1001', '1006'] };
const t = (minutes: number) => new Date(Date.parse('2026-10-10T22:57:46Z') + minutes * 60_000).toISOString();

const background = (state: Partial<Parameters<typeof run>[0]> = {}) =>
  run({ created: t(0), phase: 'Running', ...state });
const step = (index: number, state: Partial<Parameters<typeof run>[0]> = {}) =>
  run({ step: index, created: t(index === 2 ? 3 : 6.5), completed: t(index === 2 ? 3.5 : 7), ...state });

describe('a release, from the Rollout and its runs', () => {
  it('records nothing of a canary until its pods are up, and then its start, on each work item it carries', () => {
    const s = store(STABLE_RECORDED);
    expect(s.pass(rollout({ current: CANARY, stable: STABLE }), [background()], { start: START }).said).toEqual({});
    const up = rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
    const first = s.pass(up, [background()]);
    // The image's commit, its signature and what it carries are read only now that the release is to be recorded.
    expect(first.needs.start).toMatchObject({ release: releaseOf(CANARY), digest: digestOf(CANARY), found: false });
    expect(first.said).toEqual({});
    expect(s.pass(up, [background()], { start: START }).said).toEqual({
      1001: ['release.started'],
      1006: ['release.started'],
    });
    expect(s.of('1001', 'release.started')).toEqual([
      {
        release: releaseOf(CANARY),
        version: commitOf(CANARY),
        previous: commitOf(STABLE),
        commit: commitOf(CANARY),
        image: { digest: digestOf(CANARY), signed: true, admitted: true },
        watched: true,
        // As the Rollout has them: each weight with the pause and the analysis after it.
        steps: [
          { weight: 25, pauseSeconds: 180, analysis: true },
          { weight: 50, pauseSeconds: 180, analysis: true },
        ],
        dryRun: false,
      },
    ]);
    // Read again, the same state appends nothing.
    expect(s.pass(up, [background()], { start: START }).said).toEqual({});
  });

  it('records a canary refused admission as not admitted', () => {
    const s = store(STABLE_RECORDED);
    const refused = rollout({
      current: CANARY,
      stable: STABLE,
      conditions: [{ type: 'ReplicaFailure', status: 'True', reason: 'FailedCreate', message: 'admission webhook' }],
    });
    s.pass(refused, [], { start: { ...START, signed: false } });
    expect(s.of('1001', 'release.started')).toMatchObject([{ image: { signed: false, admitted: false } }]);
  });

  it('says nothing of admission for pods that were made and never became available', () => {
    const s = store(STABLE_RECORDED);
    const stuck = rollout({
      current: CANARY,
      stable: STABLE,
      conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' }],
    });
    expect(s.pass(stuck, [], { start: START }).said).toEqual({});
  });

  it('waits to record a release until it knows the version the release replaces', () => {
    const s = store();
    const { needs, said } = s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 2, weight: 25 }), [
      background(),
    ]);
    expect(needs.start).toBeUndefined();
    expect(said).toEqual({});
  });

  it('records each step as its analysis ends, with its measures in the analysis’s terms and each version’s figures', () => {
    const s = store(STABLE_RECORDED);
    const at25 = rollout({ current: CANARY, stable: STABLE, stepIndex: 3, weight: 25 });
    const figures = {
      canary: { requests: 224, errorRate: 0.004, p99Ms: 120, journeys: null },
      baseline: { requests: 640, errorRate: 0.006, p99Ms: 118, journeys: null },
    };
    const runs = [background(), step(2)];
    const first = s.pass(at25, runs, { start: START, figures: new Map([[runs[1]?.metadata.name ?? '', figures]]) });
    expect(first.needs.steps.map((r) => r.metadata.name)).toEqual([`website-${CANARY}-4-2`]);
    expect(first.said).toEqual({
      1001: ['release.started', 'canary.stepped'],
      1006: ['release.started', 'canary.stepped'],
    });
    expect(s.of('1006', 'canary.stepped')).toEqual([
      {
        release: releaseOf(CANARY),
        version: commitOf(CANARY),
        weight: 25,
        analysis: {
          phase: 'successful',
          requests: 224,
          measures: [
            { name: 'enough-requests', phase: 'successful', value: 223.5, limit: 100 },
            { name: 'errors', phase: 'successful', value: -0.0018, limit: 0.01 },
            { name: 'latency', phase: 'successful', value: -0.101, limit: 0 },
            { name: 'journeys', phase: 'successful', value: null, limit: null },
          ],
        },
        figures,
        dryRun: false,
      },
    ]);

    // The second step, and then the promotion. A pass with nothing new appends nothing.
    const at50 = rollout({ current: CANARY, stable: STABLE, stepIndex: 5, weight: 50 });
    expect(s.pass(at50, runs).said).toEqual({});
    const all = [...runs, step(5)];
    expect(s.pass(at50, all).said).toEqual({ 1001: ['canary.stepped'], 1006: ['canary.stepped'] });
    expect((s.of('1001', 'canary.stepped')[1] as PayloadOf<'canary.stepped'>).weight).toBe(50);
    const done = rollout({ current: CANARY, stable: CANARY });
    expect(s.pass(done, all).said).toEqual({ 1001: ['release.promoted'], 1006: ['release.promoted'] });
    expect(s.of('1001', 'release.promoted')).toEqual([
      {
        release: releaseOf(CANARY),
        version: commitOf(CANARY),
        previous: commitOf(STABLE),
        commit: commitOf(CANARY),
        watched: true,
        dryRun: false,
      },
    ]);
    expect(s.pass(done, all).said).toEqual({});
  });

  it('carries on from what it recorded when the line starts again, however much it missed', () => {
    const s = store(STABLE_RECORDED);
    const runs = [background(), step(2)];
    s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 3, weight: 25 }), runs, { start: START });
    // The line was down for the rest of the release: the second step and the promotion, in one pass.
    const again = store();
    again.log.splice(0, again.log.length, ...s.log);
    const all = [...runs, step(5)];
    expect(again.pass(rollout({ current: CANARY, stable: CANARY }), all).said).toEqual({
      1001: ['canary.stepped', 'release.promoted'],
      1006: ['canary.stepped', 'release.promoted'],
    });
    // A release that started while the line was down is recorded with the steps it had, once its start is read.
    const late = store(STABLE_RECORDED);
    expect(
      late.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 5, weight: 50 }), all, { start: START }).said,
    ).toEqual({
      1001: ['release.started', 'canary.stepped', 'canary.stepped'],
      1006: ['release.started', 'canary.stepped', 'canary.stepped'],
    });
  });

  it('records a release that carries no work item on the line', () => {
    const s = store(STABLE_RECORDED);
    s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 }), [background()], {
      start: { ...START, carries: [] },
    });
    s.pass(rollout({ current: CANARY, stable: CANARY }), [background(), step(2), step(5)]);
    expect(
      s.log
        .filter(
          (e) => e.work_item === null && e.payload && (e.payload as { release: string }).release === releaseOf(CANARY),
        )
        .map((e) => e.type),
    ).toEqual(['release.started', 'canary.stepped', 'canary.stepped', 'release.promoted']);
  });

  it('rolls back when an analysis run of the release failed, with the failed measures and their series', () => {
    const s = store(STABLE_RECORDED);
    const runs = [background()];
    s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 }), runs, { start: START });
    const message = `Metric "latency" assessed Failed due to failed (2) > failureLimit (1)`;
    const failedRun = background({
      phase: 'Failed',
      completed: t(3),
      message,
      metrics: {
        errors: { phase: 'Successful', value: '[0.0019]' },
        latency: { phase: 'Failed', value: '[0.2473]', message: 'x'.repeat(400) },
        journeys: { phase: 'Successful' },
      },
    });
    const aborted = rollout({ current: CANARY, stable: STABLE, stepIndex: 1, abort: true });
    const series: Series = {
      label: 'p99 latency',
      unit: 'ms',
      start: t(0),
      stepSeconds: 15,
      canary: [120, 380],
      baseline: [118, 119],
      at: 1,
    };
    const { needs, said } = s.pass(aborted, [failedRun], {
      series: new Map([[`${failedRun.metadata.name}/latency`, series]]),
    });
    // The failed run is the one whose series are read.
    expect(needs.failures.map((r) => r.metadata.name)).toEqual([failedRun.metadata.name]);
    expect(said).toEqual({ 1001: ['release.rolled-back'], 1006: ['release.rolled-back'] });
    expect(s.of('1001', 'release.rolled-back')).toEqual([
      {
        release: releaseOf(CANARY),
        version: commitOf(CANARY),
        restored: commitOf(STABLE),
        weight: 25,
        reason: message,
        failed: [{ name: 'latency', phase: 'failed', value: 0.2473, limit: 0, message: 'x'.repeat(300), series }],
        dryRun: false,
      },
    ]);
    expect(s.pass(aborted, [failedRun]).said).toEqual({});
  });

  it('records Martin’s abort, by whoever made it, and starts the release again when he retries it', () => {
    const s = store(STABLE_RECORDED);
    const runs = [background(), step(2)];
    s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 3, weight: 25 }), runs, { start: START });
    // `make stop-the-line` at 50%: the Rollout is aborted, and the runs are terminated, which fails none of them. The
    // step's run in hand ends Successful, having judged nothing: it is no step. Argo Rollouts sends the Rollout back
    // to its first step.
    const terminated = [
      background({ phase: 'Successful', message: 'Run Terminated', terminate: true }),
      step(2),
      step(5, { message: 'Run Terminated', terminate: true }),
    ];
    // Not yet acted on: nothing to say.
    const patched = rollout({ current: CANARY, stable: STABLE, stepIndex: 3, abort: true });
    delete patched.status.abortedAt;
    expect(s.pass(patched, terminated, { abortedBy: 'stop' }).needs.aborted).toBe(false);
    const aborted = rollout({ current: CANARY, stable: STABLE, stepIndex: 0, abort: true });
    // The line must say who aborted it before it is recorded.
    const asked = s.pass(aborted, terminated);
    expect(asked.needs.aborted).toBe(true);
    expect(asked.said).toEqual({});
    const { drafts } = s.pass(aborted, terminated, { abortedBy: 'stop' });
    expect(drafts.get('1001')?.map((d) => [d.type, d.actor, d.summary])).toEqual([
      ['release.aborted', 'martin', `Stop the line aborted the canary of ${commitOf(CANARY).slice(0, 7)}`],
    ]);
    expect(s.of('1006', 'release.aborted')).toEqual([
      {
        release: releaseOf(CANARY),
        version: commitOf(CANARY),
        restored: commitOf(STABLE),
        abortedAt: ABORTED_AT,
        by: 'stop',
      },
    ]);
    // Still aborted: nothing more, and nothing to ask.
    const again = s.pass(aborted, terminated, { abortedBy: 'stop' });
    expect([again.said, again.needs.aborted]).toEqual([{}, false]);
    // He retries it: the release starts again, and goes on to its promotion.
    const retried = [
      ...terminated,
      background({ name: 'website-68ff668868-4.1', created: t(20) }),
      step(2, { name: 'website-68ff668868-4-2.1', created: t(23), completed: t(23.5) }),
    ];
    const going = s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 3, weight: 25 }), retried);
    expect(going.drafts.get('1001')?.map((d) => [d.type, d.summary])).toEqual([
      ['release.started', `${commitOf(CANARY).slice(0, 7)} started again after its abort`],
      ['canary.stepped', 'Canary at 25%: the analysis passed'],
    ]);
    // Martin aborts the retry by hand.
    const byHand = rollout({ current: CANARY, stable: STABLE, stepIndex: 0, abort: true, abortedAt: t(25) });
    expect(s.pass(byHand, retried, { abortedBy: 'martin' }).said).toEqual({
      1001: ['release.aborted'],
      1006: ['release.aborted'],
    });
    expect(s.of('1001', 'release.aborted').map((p) => (p as PayloadOf<'release.aborted'>).by)).toEqual([
      'stop',
      'martin',
    ]);
    expect(s.of('1001', 'release.rolled-back')).toEqual([]);
  });

  it('records nothing when an analysis that could not judge aborts the release: it stays unfinished', () => {
    const s = store(STABLE_RECORDED);
    const runs = [background(), step(2)];
    s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 3, weight: 25 }), runs, { start: START });
    // An analysis that ends in Error is no failure of the canary, and nobody stopped it: its step is recorded as it
    // ended, and the abort it made is not Martin's.
    const error = step(5, { phase: 'Error', created: t(15), completed: t(15) });
    const aborted = rollout({ current: CANARY, stable: STABLE, stepIndex: 0, abort: true, abortedAt: t(15.01) });
    const judged = s.pass(aborted, [...runs, error], { abortedBy: 'martin' });
    expect(judged.needs).toMatchObject({ failures: [], aborted: false });
    expect(judged.said).toEqual({ 1001: ['canary.stepped'], 1006: ['canary.stepped'] });
    expect(s.pass(aborted, [...runs, error], { abortedBy: 'martin' }).said).toEqual({});
    // Martin retries it, and later aborts it himself: that abort is his, whatever the earlier run said.
    const later = [...runs, error, step(2, { name: 'website-68ff668868-4-2.1', created: t(20), completed: t(20.5) })];
    s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 3, weight: 25 }), later);
    const byHand = rollout({ current: CANARY, stable: STABLE, stepIndex: 0, abort: true, abortedAt: t(25) });
    expect(s.pass(byHand, later, { abortedBy: 'martin' }).said).toEqual({
      1001: ['release.aborted'],
      1006: ['release.aborted'],
    });
  });

  it('records a retry and a second abort that both happened between two reads', () => {
    const s = store(STABLE_RECORDED);
    s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 }), [background()], {
      start: { ...START, carries: ['1001'] },
    });
    const first = rollout({ current: CANARY, stable: STABLE, stepIndex: 0, abort: true, abortedAt: t(5) });
    expect(s.pass(first, [background()], { abortedBy: 'stop' }).said).toEqual({ 1001: ['release.aborted'] });
    // Read again with the same abort: nothing. With a later one, he retried it and aborted it again meanwhile.
    expect(s.pass(first, [background()], { abortedBy: 'stop' }).said).toEqual({});
    const second = rollout({ current: CANARY, stable: STABLE, stepIndex: 0, abort: true, abortedAt: t(9) });
    expect(s.pass(second, [background()], { abortedBy: 'martin' }).said).toEqual({
      1001: ['release.started', 'release.aborted'],
    });
    expect(s.of('1001', 'release.aborted').map((p) => (p as PayloadOf<'release.aborted'>).by)).toEqual([
      'stop',
      'martin',
    ]);
  });

  it('judges a retry that ended between two reads by its own runs, not by the abort before it', () => {
    const aborted = () => {
      const s = store(STABLE_RECORDED);
      s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 }), [background()], {
        start: { ...START, carries: ['1001'] },
      });
      s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 0, abort: true, abortedAt: t(5) }), [background()], {
        abortedBy: 'stop',
      });
      return s;
    };
    const again = rollout({ current: CANARY, stable: STABLE, stepIndex: 0, abort: true, abortedAt: t(9) });
    // The retry's step failed, and Argo Rollouts rolled it back: a rollback, whoever the line would say aborted it.
    const failed = step(2, {
      name: 'website-68ff668868-4-2.1',
      created: t(6),
      completed: t(9),
      phase: 'Failed',
      message: 'Metric "errors" assessed Failed',
      metrics: { errors: { phase: 'Failed', value: '[0.03]' } },
    });
    expect(aborted().pass(again, [background(), failed], { abortedBy: 'martin' }).said).toEqual({
      1001: ['release.started', 'canary.stepped', 'release.rolled-back'],
    });
    // The retry's analysis could not judge it, and aborted it: nobody did.
    const error = step(2, { name: 'website-68ff668868-4-2.1', created: t(6), completed: t(9), phase: 'Error' });
    expect(aborted().pass(again, [background(), error], { abortedBy: 'martin' }).said).toEqual({
      1001: ['release.started', 'canary.stepped'],
    });
  });

  it('takes a run that ended in Error with no time it ended for none that made the abort', () => {
    const s = store(STABLE_RECORDED);
    s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 }), [background()], {
      start: { ...START, carries: ['1001'] },
    });
    const untimed = background({ name: 'website-68ff668868-4.1', created: t(1), phase: 'Error' });
    const aborted = rollout({ current: CANARY, stable: STABLE, stepIndex: 0, abort: true, abortedAt: t(5) });
    expect(s.pass(aborted, [background(), untimed], { abortedBy: 'martin' }).said).toEqual({
      1001: ['release.aborted'],
    });
  });

  it('records no abort until the Rollout says when, as a time', () => {
    const s = store(STABLE_RECORDED);
    s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 }), [background()], { start: START });
    const odd = rollout({ current: CANARY, stable: STABLE, stepIndex: 0, abort: true, abortedAt: 'yesterday' });
    expect(s.pass(odd, [background()], { abortedBy: 'martin' })).toMatchObject({ said: {}, needs: { aborted: false } });
  });

  it('starts a rolled-back release again when Martin retries it, under the same name', () => {
    const s = store(STABLE_RECORDED);
    s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 }), [background()], {
      start: { ...START, carries: ['1001'] },
    });
    const failed = step(2, {
      phase: 'Failed',
      message: 'Metric "errors" assessed Failed',
      metrics: { errors: { phase: 'Failed', value: '[0.03]' } },
    });
    s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 2, abort: true }), [background(), failed]);
    expect(s.log.filter((e) => e.work_item === '1001').map((e) => e.type)).toEqual([
      'release.started',
      'canary.stepped',
      'release.rolled-back',
    ]);
    // Still aborted: nothing more.
    expect(
      s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 2, abort: true }), [background(), failed]).said,
    ).toEqual({});
    // Retried: it starts again, and its new runs are its steps.
    const retry = [
      background(),
      failed,
      step(2, { name: 'website-68ff668868-4-2.1', created: t(20), completed: t(20.5) }),
    ];
    // Its steps are no part of its name, so they are read again: here the Rollout went to half the traffic at once.
    const retried = rollout({ current: CANARY, stable: STABLE, stepIndex: 3, weight: 25 });
    retried.spec.strategy.canary = { steps: [{ setWeight: 50 }, { pause: { duration: '5m' } }, { analysis: {} }] };
    const { said } = s.pass(retried, retry);
    expect(said).toEqual({ 1001: ['release.started', 'canary.stepped'] });
    expect(s.of('1001', 'release.started').map((p) => (p as PayloadOf<'release.started'>).steps)).toEqual([
      [
        { weight: 25, pauseSeconds: 180, analysis: true },
        { weight: 50, pauseSeconds: 180, analysis: true },
      ],
      [{ weight: 50, pauseSeconds: 300, analysis: true }],
    ]);
    // Martin aborts the retry: its earlier failure is not this attempt's, so it is his abort, not a rollback.
    expect(s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 3, abort: true }), retry).said).toEqual({});
    // A run that fails in this attempt, before the line has said who aborted it, rolls it back again.
    const again = [
      ...retry,
      background({
        name: 'website-68ff668868-4.1',
        created: t(20),
        completed: t(23),
        phase: 'Failed',
        metrics: { latency: { phase: 'Failed', value: '[0.3]' } },
      }),
    ];
    expect(s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 3, abort: true }), again).said).toEqual({
      1001: ['release.rolled-back'],
    });
    expect(
      (s.of('1001', 'release.rolled-back')[1] as PayloadOf<'release.rolled-back'>).failed.map((m) => m.name),
    ).toEqual(['latency']);
  });

  it('records a stable version it has no record of as found live, by the factory, and not watched', () => {
    const s = store();
    const settled = rollout({ current: CANARY, stable: CANARY });
    const runs = [background({ phase: 'Successful' }), step(2), step(5)];
    expect(s.pass(settled, runs).needs.start).toEqual({
      release: releaseOf(CANARY),
      digest: digestOf(CANARY),
      found: true,
      previous: undefined,
    });
    const { drafts } = s.pass(settled, runs, { start: START });
    expect([...drafts.keys()]).toEqual(['1001', '1006']);
    expect(drafts.get('1001')?.map((d) => [d.type, d.actor])).toEqual([
      ['release.started', 'factory'],
      ['release.promoted', 'factory'],
    ]);
    expect(s.of('1006', 'release.started')).toEqual([
      {
        release: releaseOf(CANARY),
        version: commitOf(CANARY),
        // The line never saw the version it replaced.
        previous: commitOf(CANARY),
        commit: commitOf(CANARY),
        image: { digest: digestOf(CANARY), signed: true, admitted: true },
        watched: false,
        // Nobody saw it step, and the Rollout may have said otherwise then.
        steps: null,
        dryRun: false,
      },
    ]);
    // Its steps were never watched, and are not recorded after the fact.
    expect(s.of('1001', 'canary.stepped')).toEqual([]);
    expect(s.pass(settled, runs).said).toEqual({});
  });

  it('records a version found live with none to carry on the line, naming the last it saw promoted before it', () => {
    const s = store();
    const { drafts } = s.pass(rollout({ current: CANARY, stable: CANARY }), [], {
      start: { ...START, carries: [] },
      lastPromoted: commitOf(STABLE),
    });
    expect([...drafts.keys()]).toEqual([null]);
    expect(s.of(null, 'release.promoted')).toMatchObject([{ previous: commitOf(STABLE), watched: false }]);
  });
});

describe('a release of a version released before', () => {
  /** CANARY released over STABLE and promoted, on the work items it carries. */
  function promoted(carries = ['1001']) {
    const s = store(STABLE_RECORDED);
    s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 }), [background()], {
      start: { ...START, carries },
    });
    const runs = [background({ phase: 'Successful', completed: t(8) }), step(2), step(5)];
    s.pass(rollout({ current: CANARY, stable: CANARY }), runs);
    return { s, runs };
  }
  const BACK: Start = { commit: commitOf(STABLE), signed: true, carries: ['1010'] };

  it('is a release of its own: the same hash at a later revision', () => {
    const { s, runs } = promoted();
    // STABLE pinned again: Argo Rollouts gives it its old hash and the next revision.
    const before = [...runs, step(2, { hash: STABLE, stable: 'aaaaaaaaaa' })];
    const now = [
      ...before,
      run({ hash: STABLE, revision: 5, stable: CANARY, step: 2, created: t(20), completed: t(21) }),
    ];
    const canary = rollout({ current: STABLE, stable: CANARY, revision: 5, stepIndex: 3, weight: 25 });
    const { needs } = s.pass(canary, now);
    expect(needs.start).toMatchObject({
      release: `${STABLE}-5`,
      found: false,
      previous: { release: releaseOf(CANARY) },
    });
    // Its one step is its own: the step of STABLE's first release, still in the cluster, is not.
    expect(s.pass(canary, now, { start: BACK }).said).toEqual({ 1010: ['release.started', 'canary.stepped'] });
    expect(s.of('1010', 'release.started')).toMatchObject([
      { release: `${STABLE}-5`, version: commitOf(STABLE), previous: commitOf(CANARY), watched: true },
    ]);
    const back = rollout({ current: STABLE, stable: STABLE, revision: 5 });
    expect(s.pass(back, now).said).toEqual({ 1010: ['release.promoted'] });
    expect(s.pass(back, now).said).toEqual({});
    // The release after it replaces STABLE as this release left it.
    const next = s.pass(rollout({ current: CANARY, stable: STABLE, revision: 6, stepIndex: 1, weight: 25 }), now);
    expect(next.needs.start).toMatchObject({ release: `${CANARY}-6`, previous: { release: `${STABLE}-5` } });
  });

  it('after a rollback, is a release of its own and no retry, and the stable version taking the next revision is none', () => {
    const s = store(STABLE_RECORDED);
    s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 }), [background()], { start: START });
    const failed = step(2, { phase: 'Failed', metrics: { errors: { phase: 'Failed', value: '[0.03]' } } });
    s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 2, abort: true }), [background(), failed]);
    expect(s.of('1001', 'release.rolled-back')).toHaveLength(1);
    // STABLE pinned again: the Rollout goes back to it with no canary, at the next revision. Nothing was released.
    const back = s.pass(rollout({ current: STABLE, stable: STABLE, revision: 5 }), [background(), failed]);
    expect(back.needs.start).toBeUndefined();
    expect(back.said).toEqual({});
    // CANARY pinned again, at the revision after: a release of its own, whose runs are its own.
    const runs = [background(), failed, background({ revision: 6, created: t(30) })];
    const again = rollout({ current: CANARY, stable: STABLE, revision: 6, stepIndex: 1, weight: 25 });
    expect(
      s
        .pass(again, runs, { start: START })
        .drafts.get('1001')
        ?.map((d) => [d.type, d.summary]),
    ).toEqual([['release.started', `${commitOf(CANARY).slice(0, 7)} signed and admitted; canary started`]]);
    expect(s.of('1001', 'release.started').map((p) => (p as PayloadOf<'release.started'>).release)).toEqual([
      releaseOf(CANARY),
      `${CANARY}-6`,
    ]);
    // Aborted with none of its own runs failed, it is Martin's abort: the earlier failure was the earlier release's.
    const aborted = rollout({ current: CANARY, stable: STABLE, revision: 6, stepIndex: 1, abort: true });
    expect(s.pass(aborted, runs, { abortedBy: 'martin' }).said).toEqual({
      1001: ['release.aborted'],
      1006: ['release.aborted'],
    });
    expect(s.of('1001', 'release.aborted')).toMatchObject([{ release: `${CANARY}-6`, by: 'martin' }]);
  });

  it('is found live when the line missed all of it, not taken for an earlier release of its image that rolled back', () => {
    const s = store(STABLE_RECORDED);
    s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 }), [background()], { start: START });
    const failed = step(2, { phase: 'Failed', metrics: { errors: { phase: 'Failed', value: '[0.03]' } } });
    s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 2, abort: true }), [background(), failed]);
    // CANARY pinned again, released and promoted while the line was down.
    const { needs, said } = s.pass(rollout({ current: CANARY, stable: CANARY, revision: 6 }), [background(), failed]);
    expect(needs.start).toMatchObject({ release: `${CANARY}-6`, found: true });
    expect(said).toEqual({});
  });

  it('reads no revision until the status has caught up with the spec', () => {
    const s = store(STABLE_RECORDED);
    s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 }), [background()], { start: START });
    s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 1, abort: true }), [background()]);
    // A new image pinned: the revision is the new version's, while the status still names the aborted canary.
    const behind = rollout({ current: CANARY, stable: STABLE, revision: 5, stepIndex: 1, weight: 25, behind: true });
    expect(s.pass(behind, [background()], { start: START }).needs.start).toBeUndefined();
  });

  it('reads a release recorded by its hash alone, before releases were named by revision, as it was then', () => {
    const legacy = (release: string, payload: unknown) => ({ ...(payload as object), release });
    const s = store([
      ...STABLE_RECORDED.map((e) => ({ ...e, payload: legacy(STABLE, e.payload) })),
      {
        target: '1001',
        type: 'release.started',
        payload: legacy(CANARY, {
          version: commitOf(CANARY),
          previous: commitOf(STABLE),
          commit: commitOf(CANARY),
          image: { digest: digestOf(CANARY), signed: true, admitted: true },
          watched: true,
          steps: null,
          dryRun: false,
        }),
      },
    ]);
    // In flight when the line began naming releases by revision: it goes on under its old name.
    const runs = [background(), step(2)];
    const at25 = rollout({ current: CANARY, stable: STABLE, stepIndex: 3, weight: 25 });
    expect(s.pass(at25, runs).said).toEqual({ 1001: ['canary.stepped'] });
    expect(s.pass(rollout({ current: CANARY, stable: CANARY }), runs).said).toEqual({ 1001: ['release.promoted'] });
    expect(s.of('1001', 'release.promoted')).toMatchObject([{ release: CANARY }]);
    // Promoted, its hash pinned again later is a release of its own.
    const back = s.pass(rollout({ current: STABLE, stable: CANARY, revision: 5, stepIndex: 1, weight: 25 }), runs);
    expect(back.needs.start).toMatchObject({ release: `${STABLE}-5`, previous: { release: CANARY } });
  });

  it('starts a release of its own over one recorded by its hash alone that rolled back', () => {
    const legacy = (release: string, payload: unknown) => ({ ...(payload as object), release });
    const failed = step(2, { phase: 'Failed', metrics: { errors: { phase: 'Failed', value: '[0.03]' } } });
    const s = store(STABLE_RECORDED.map((e) => ({ ...e, payload: legacy(STABLE, e.payload) })));
    s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 }), [background()], { start: START });
    s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 2, abort: true }), [background(), failed]);
    // As the line recorded it before the revision: renamed to its hash alone.
    for (const e of s.log) {
      if ((e.payload as { release: string }).release === releaseOf(CANARY)) e.payload = legacy(CANARY, e.payload);
    }
    const again = rollout({ current: CANARY, stable: STABLE, revision: 6, stepIndex: 1, weight: 25 });
    expect(s.pass(again, [background(), failed]).needs.start).toMatchObject({ release: `${CANARY}-6` });
  });
});

describe('a dry run’s release', () => {
  const merge = { commit: 'd'.repeat(40), at: '2026-10-11T10:00:00Z' };
  const at = (seconds: number) => new Date(Date.parse(merge.at) + seconds * 1000);
  const recordOf = (log: { type: string; payload: unknown }[]) =>
    recordedFrom(log.map((e) => ({ work_item: '1007', ts: merge.at, ...e })))
      .get(dryRunRelease(merge.commit))
      ?.get('1007');

  it('starts a while after the merge, steps, and promotes, each by the dry run’s word, and is said to be one', () => {
    const log: { type: string; payload: unknown }[] = [];
    const due = (seconds: number) => {
      const drafts = dryRunEvents(merge, 'a'.repeat(40), recordOf(log), at(seconds), 60_000);
      log.push(...drafts.map((d) => ({ type: d.type, payload: d.payload })));
      for (const draft of drafts) expect(validate(asEvent('1007', draft, at(seconds).toISOString())).ok).toBe(true);
      return drafts.map((d) => d.type);
    };
    expect(due(30)).toEqual([]);
    expect(due(60)).toEqual(['release.started']);
    expect(due(90)).toEqual([]);
    expect(due(150)).toEqual(['canary.stepped']);
    expect(due(240)).toEqual(['canary.stepped', 'release.promoted']);
    expect(due(600)).toEqual([]);
    expect(log.map((e) => e.payload)).toEqual([
      expect.objectContaining({
        release: 'dry-run-dddddddddddd',
        watched: true,
        steps: [
          { weight: 25, pauseSeconds: 60, analysis: true },
          { weight: 50, pauseSeconds: 60, analysis: true },
        ],
        dryRun: true,
      }),
      expect.objectContaining({
        weight: 25,
        analysis: { phase: 'successful', requests: null, measures: [] },
        dryRun: true,
      }),
      expect.objectContaining({ weight: 50, dryRun: true }),
      expect.objectContaining({ previous: 'a'.repeat(40), dryRun: true }),
    ]);
    expect(log[0]?.payload).not.toHaveProperty('image');
  });
});

describe('a canary’s steps, as a release records them', () => {
  type Steps = Parameters<typeof planOf>[0];
  const plan = (steps: Steps) => planOf(steps);

  it('are each weight set, with the pauses and the analysis that follow it, before the next', () => {
    expect(
      plan([
        { setWeight: 10 },
        { setWeight: 20 },
        { pause: { duration: '1m' } },
        { pause: { duration: 30 } },
        { analysis: {} },
        { pause: { duration: '1h30m' } },
        { setWeight: 60 },
      ]),
    ).toEqual([
      { weight: 10, pauseSeconds: 0, analysis: false },
      { weight: 20, pauseSeconds: 5490, analysis: true },
      { weight: 60, pauseSeconds: 0, analysis: false },
    ]);
  });

  it('hold the canary until it is promoted at a pause with no duration', () => {
    expect(plan([{ setWeight: 25 }, { pause: {} }, { pause: { duration: '1m' } }])).toEqual([
      { weight: 25, pauseSeconds: null, analysis: false },
    ]);
    // Steps of other kinds change no weight, and a Rollout with none of these steps has none.
    expect(plan([{}, {}])).toEqual([]);
  });

  it('are not known when a pause cannot be read, a step has none of the traffic, or there are more than an event holds', () => {
    expect(plan([{ setWeight: 25 }, { pause: { duration: 'a while' } }])).toBeNull();
    // A step's verdict is at 1% at the least, so a step at none of the traffic would not match it.
    expect(plan([{ analysis: {} }, { setWeight: 25 }])).toBeNull();
    expect(plan([{ setWeight: 0 }, { setWeight: 25 }])).toBeNull();
    // Pauses that add up to more seconds than a number holds exactly.
    expect(plan([{ setWeight: 25 }, { pause: { duration: 2 ** 52 } }, { pause: { duration: 2 ** 52 } }])).toBeNull();
    expect(plan(Array.from({ length: 21 }, (_, i) => ({ setWeight: i + 1 })))).toBeNull();
  });

  it('read durations as Argo Rollouts does: a number or bare digits in seconds, or a Go duration', () => {
    expect([30, '45', '3m', '1h', '1m30s', '1.5m', '.5m', '500ms', '2000000us', '3000000000ns'].map(secondsOf)).toEqual(
      [30, 45, 180, 3600, 90, 90, 30, 1, 2, 3],
    );
    expect(['', '3 m', 'm', '-1', '1d'].map(secondsOf)).toEqual(Array(5).fill(undefined));
    expect(secondsOf(-1)).toBeUndefined();
    // More seconds than a number holds exactly are not read, rather than read as some other length.
    expect(['9007199254740993', '9007199254740993s', `1${'0'.repeat(400)}h`].map(secondsOf)).toEqual(
      Array(3).fill(undefined),
    );
  });
});

describe('the versions a run compared', () => {
  it('are read as pod-template hashes, and anything else the Rollout passed is not queried', () => {
    expect(hashesOf(run({ created: t(0) }))).toEqual({ stable: STABLE, canary: CANARY });
    expect(hashesOf(run({ created: t(0), stable: 'x"} or up{a="' }))).toBeUndefined();
  });
});
