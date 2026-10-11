import type { PayloadOf } from '@software-factory/events';
import { validate } from '@software-factory/events/schemas';
import { describe, expect, it } from 'vitest';
import type { Draft } from '../../src/line/gates.ts';
import { asEvent } from '../../src/line/gates.ts';
import type { AnalysisRun, Rollout } from '../../src/release/read.ts';
import {
  dryRunEvents,
  dryRunRelease,
  type Facts,
  observe,
  recordedFrom,
  releaseEvents,
  releaseNeeds,
  type Series,
  type Start,
  type Target,
} from '../../src/release/watch.ts';
import { CANARY, commitOf, digestOf, rollout, run, STABLE } from './fixtures.ts';

/**
 * A store of release events, as the line keeps it: each pass appends what `releaseEvents` drafts, and the next pass
 * reads it back. Starting the line again is a pass over the same store.
 */
function store(seed: { target: Target; type: string; payload: unknown }[] = []) {
  const log = seed.map(({ target, type, payload }) => ({ work_item: target, type, payload }));
  return {
    log,
    /** One pass over the Rollout and its runs; returns what it appended, by target, as `[type, summary]`. */
    pass(r: Rollout, runs: AnalysisRun[], read: Partial<Facts> & { start?: Start } = {}) {
      const o = observe(r, runs);
      const recorded = recordedFrom(log);
      const needs = releaseNeeds(o, recorded);
      const facts: Facts = { figures: new Map(), series: new Map(), ...read };
      const drafts = releaseEvents(o, recorded, facts);
      for (const [target, list] of drafts) {
        for (const draft of list) {
          // Every draft is an event the store would take.
          const event = asEvent(target, draft, '2026-10-11T12:00:00Z');
          expect(validate(event)).toEqual({ ok: true });
          log.push({ work_item: target, type: draft.type, payload: draft.payload });
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
      release: STABLE,
      version: commitOf(STABLE),
      previous: commitOf(STABLE),
      commit: commitOf(STABLE),
      image: { digest: digestOf(STABLE), signed: true, admitted: true },
      watched: false,
      dryRun: false,
    },
  },
  {
    target: null,
    type: 'release.promoted',
    payload: {
      release: STABLE,
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
    expect(first.needs.start).toMatchObject({ release: CANARY, digest: digestOf(CANARY), found: false });
    expect(first.said).toEqual({});
    expect(s.pass(up, [background()], { start: START }).said).toEqual({
      1001: ['release.started'],
      1006: ['release.started'],
    });
    expect(s.of('1001', 'release.started')).toEqual([
      {
        release: CANARY,
        version: commitOf(CANARY),
        previous: commitOf(STABLE),
        commit: commitOf(CANARY),
        image: { digest: digestOf(CANARY), signed: true, admitted: true },
        watched: true,
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
        release: CANARY,
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
        release: CANARY,
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
    const again = store(s.log.map((e) => ({ target: e.work_item, type: e.type, payload: e.payload })));
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
        .filter((e) => e.work_item === null && e.payload && (e.payload as { release: string }).release === CANARY)
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
        release: CANARY,
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

  it('records nothing when Martin aborts a release: it stays unfinished until he retries it, and then goes on', () => {
    const s = store(STABLE_RECORDED);
    const runs = [background(), step(2)];
    s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 3, weight: 25 }), runs, { start: START });
    // `make stop-the-line`: the Rollout is aborted, and the runs are terminated, which fails none of them.
    const terminated = [background({ phase: 'Successful', message: 'Run Terminated', terminate: true }), step(2)];
    const aborted = rollout({ current: CANARY, stable: STABLE, stepIndex: 3, abort: true });
    expect(s.pass(aborted, terminated).said).toEqual({});
    expect(s.pass(aborted, terminated).said).toEqual({});
    // An analysis that could not judge (Error) is no failure of the canary either: its step is recorded as it ended.
    const error = step(5, { phase: 'Error' });
    const judged = s.pass(aborted, [...terminated, error]);
    expect(judged.needs.failures).toEqual([]);
    expect(judged.said).toEqual({ 1001: ['canary.stepped'], 1006: ['canary.stepped'] });
    // He retries it: the release goes on from where it was, and promotes.
    const retried = [
      background({ name: 'website-68ff668868-4.1', created: t(20) }),
      step(2),
      error,
      step(5, { name: 'website-68ff668868-4-5.1', created: t(30), completed: t(30.5) }),
    ];
    expect(s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 6, weight: 50 }), retried).said).toEqual({
      1001: ['canary.stepped'],
      1006: ['canary.stepped'],
    });
    expect(s.pass(rollout({ current: CANARY, stable: CANARY }), retried).said).toEqual({
      1001: ['release.promoted'],
      1006: ['release.promoted'],
    });
    expect(s.of('1001', 'release.rolled-back')).toEqual([]);
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
    const { said } = s.pass(rollout({ current: CANARY, stable: STABLE, stepIndex: 3, weight: 25 }), retry);
    expect(said).toEqual({ 1001: ['release.started', 'canary.stepped'] });
    expect(s.of('1001', 'release.started')).toHaveLength(2);
    expect(s.pass(rollout({ current: CANARY, stable: CANARY }), retry).said).toEqual({ 1001: ['release.promoted'] });
  });

  it('records a stable version it has no record of as found live, by the factory, and not watched', () => {
    const s = store();
    const settled = rollout({ current: CANARY, stable: CANARY });
    const runs = [background({ phase: 'Successful' }), step(2), step(5)];
    expect(s.pass(settled, runs).needs.start).toEqual({
      release: CANARY,
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
        release: CANARY,
        version: commitOf(CANARY),
        // The line never saw the version it replaced.
        previous: commitOf(CANARY),
        commit: commitOf(CANARY),
        image: { digest: digestOf(CANARY), signed: true, admitted: true },
        watched: false,
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

describe('a dry run’s release', () => {
  const merge = { commit: 'd'.repeat(40), at: '2026-10-11T10:00:00Z' };
  const at = (seconds: number) => new Date(Date.parse(merge.at) + seconds * 1000);
  const recordOf = (log: { type: string; payload: unknown }[]) =>
    recordedFrom(log.map((e) => ({ work_item: '1007', ...e })))
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
      expect.objectContaining({ release: 'dry-run-dddddddddddd', watched: true, dryRun: true }),
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
