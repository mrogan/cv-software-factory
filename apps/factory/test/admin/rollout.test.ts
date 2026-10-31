/**
 * Martin's controls of the canary, as the admin service decides them from the Rollout: which release it acts on, and
 * the patches each control makes, the same as `kubectl argo rollouts`, and only of the fields the admission policy
 * lets it change (deploy/base/admission/website/rollout-controls.yaml).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { type Canary, canaryOf, latestRecord, planOf, summaryOf } from '../../src/admin/rollout.ts';
import { recordedFrom, type TargetRecord } from '../../src/release/recorded.ts';
import { DEPLOY } from '../deploy.ts';
import { CANARY, commitOf, type RolloutState, releaseOf, rollout, STABLE } from '../release/fixtures.ts';

const read = (state: RolloutState, paused = false) => {
  const r = rollout(state);
  return canaryOf({ ...r, metadata: { ...r.metadata, resourceVersion: '7' }, spec: { ...r.spec, paused } });
};

describe('the canary, as the controls see it', () => {
  it('is the release in flight, by the name the line gives it, with its weight and the next step’s', () => {
    expect(read({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 })).toEqual({
      release: releaseOf(CANARY),
      resourceVersion: '7',
      inFlight: true,
      aborted: false,
      paused: false,
      promotingFully: false,
      judgedBad: false,
      weight: 25,
      next: { index: 3, weight: 50 },
    });
    // At 50% the next is all of the traffic: there is no step before it.
    expect(read({ current: CANARY, stable: STABLE, stepIndex: 4, weight: 50 })?.next).toBeUndefined();
  });

  it('is named as the line recorded it: under its pod hash alone, or at its revision', () => {
    const r = rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
    const withVersion = { ...r, metadata: { ...r.metadata, resourceVersion: '7' } };
    const started = (release: string) => ({
      work_item: '1290',
      ts: '2026-10-24T09:00:00.000Z',
      type: 'release.started',
      payload: { release, version: commitOf(CANARY) },
    });
    // A release the line recorded before releases were named by revision, still in flight: the line's name for it.
    expect(canaryOf(withVersion, recordedFrom([started(CANARY)]))?.release).toBe(CANARY);
    // Recorded at its revision, it is that.
    expect(canaryOf(withVersion, recordedFrom([started(releaseOf(CANARY))]))?.release).toBe(releaseOf(CANARY));
  });

  it('is judged bad while the controller holds it paused on an Inconclusive run, and not once it is aborted', () => {
    const held = { current: CANARY, stable: STABLE, stepIndex: 5, weight: 50, pausedFor: 'InconclusiveAnalysis' };
    expect(read(held)).toMatchObject({ inFlight: true, judgedBad: true, paused: false, weight: 50 });
    // Paused by a step's own pause, the controller names another reason.
    expect(read({ ...held, pausedFor: 'CanaryPauseStep' })?.judgedBad).toBe(false);
    // An abort drops the pause conditions; one left behind by a write in between still judges nothing.
    expect(read({ ...held, abort: true })).toMatchObject({ judgedBad: false, aborted: true });
  });

  it('is stopped once aborted, at nought; between releases, nothing is in flight; and it waits for the status', () => {
    expect(read({ current: CANARY, stable: STABLE, stepIndex: 0, abort: true })).toMatchObject({
      inFlight: false,
      aborted: true,
      weight: 0,
    });
    expect(read({ current: STABLE, stable: STABLE })).toMatchObject({ inFlight: false, aborted: false });
    expect(read({ current: CANARY, stable: STABLE, behind: true })).toBeUndefined();
  });
});

describe('the record of a release', () => {
  const record = (attempts: number, ended?: TargetRecord['ended']) =>
    ({ attempts, ended, started: {}, startedAt: '', steps: 0, stepsBefore: 0 }) as unknown as TargetRecord;

  it('is the one that has ended, not a work item’s closed before it ended, in either order', () => {
    expect(latestRecord([record(1), record(1, 'aborted')])?.ended).toBe('aborted');
    expect(latestRecord([record(1, 'aborted'), record(1)])?.ended).toBe('aborted');
  });

  it('is the latest attempt’s, not an earlier attempt’s that a closed work item kept', () => {
    expect(latestRecord([record(2), record(1, 'aborted')])).toMatchObject({ attempts: 2, ended: undefined });
    expect(latestRecord([])).toBeUndefined();
  });
});

describe('each control', () => {
  const flying: Canary = {
    release: releaseOf(CANARY),
    resourceVersion: '7',
    inFlight: true,
    aborted: false,
    paused: false,
    promotingFully: false,
    judgedBad: false,
    weight: 25,
    next: { index: 3, weight: 50 },
  };
  const paused = { ...flying, paused: true };
  const judgedBad = { ...flying, judgedBad: true };
  const stopped = { ...flying, inFlight: false, aborted: true, weight: 0 };
  const over = { ...flying, inFlight: false };

  it('makes the patch `kubectl argo rollouts` makes', () => {
    expect(planOf('pause', flying)).toEqual({ spec: { paused: true } });
    expect(planOf('resume', paused)).toEqual({ spec: { paused: false } });
    expect(planOf('abort', flying)).toEqual({ status: { abort: true } });
    expect(planOf('retry', stopped)).toEqual({ status: { abort: false } });
    expect(planOf('promote', flying)).toEqual({
      status: { pauseConditions: null, controllerPause: false, currentStepIndex: 3 },
      to: 50,
    });
    expect(planOf('promote-fully', flying)).toEqual({ status: { promoteFull: true }, to: 100 });
  });

  it('resumes a paused canary it promotes', () => {
    expect(planOf('promote', paused)).toMatchObject({ spec: { paused: false }, to: 50 });
    expect(planOf('promote-fully', paused)).toMatchObject({ spec: { paused: false }, to: 100 });
  });

  it('is refused when the canary is not in the state it acts on', () => {
    for (const action of ['pause', 'resume', 'abort', 'promote', 'promote-fully'] as const) {
      expect(planOf(action, stopped), action).toHaveProperty('refused');
      expect(planOf(action, over), action).toHaveProperty('refused');
    }
    expect(planOf('pause', paused)).toHaveProperty('refused');
    expect(planOf('resume', flying)).toHaveProperty('refused');
    expect(planOf('promote', { ...flying, next: undefined })).toHaveProperty('refused');
    // Being promoted fully already: a second press, or another tab, promotes nothing more.
    for (const action of ['promote', 'promote-fully'] as const) {
      expect(planOf(action, { ...flying, promotingFully: true })).toEqual({
        refused: 'The canary is being promoted fully already.',
      });
    }
    expect(planOf('retry', flying)).toHaveProperty('refused');
    expect(planOf('retry', over)).toHaveProperty('refused');
  });

  it('takes only Promote fully and Abort of a canary the analysis judged bad and paused for Martin', () => {
    const refusal = {
      refused:
        'The analysis judged the canary bad, and it waits for you: promote it fully past its verdict, or abort it.',
    };
    for (const action of ['promote', 'pause', 'resume'] as const) {
      expect(planOf(action, judgedBad), action).toEqual(refusal);
      expect(planOf(action, { ...judgedBad, paused: true }), action).toEqual(refusal);
    }
    expect(planOf('promote-fully', judgedBad)).toEqual({ status: { promoteFull: true }, to: 100 });
    expect(planOf('abort', judgedBad)).toEqual({ status: { abort: true } });
    // His own pause, set before the analysis judged it, is cleared with either, so none outlives the canary.
    expect(planOf('abort', { ...judgedBad, paused: true })).toEqual({
      status: { abort: true },
      spec: { paused: false },
    });
    expect(planOf('retry', judgedBad)).toHaveProperty('refused');
  });

  it('changes only the fields the admission policy lets the admin service change', async () => {
    const policy = parse(
      (await readFile(join(DEPLOY, 'base/admission/website/rollout-controls.yaml'), 'utf-8')).split('\n---\n')[0] ?? '',
    ) as { spec: { variables: { name: string; expression: string }[] } };
    const listed = (name: string) =>
      [...(policy.spec.variables.find((v) => v.name === name)?.expression ?? '').matchAll(/'([^']+)'/g)].map(
        (m) => m[1],
      );
    for (const canary of [flying, paused, stopped, judgedBad]) {
      for (const action of ['pause', 'resume', 'abort', 'promote', 'promote-fully', 'retry'] as const) {
        const plan = planOf(action, canary);
        if ('refused' in plan) continue;
        for (const field of Object.keys(plan.spec ?? {})) expect(listed('spec'), action).toContain(field);
        for (const field of Object.keys(plan.status ?? {})) expect(listed('status'), action).toContain(field);
      }
    }
  });

  it('is recorded in the console’s words', () => {
    expect(summaryOf({ action: 'promote', release: 'r', weight: 25, to: 50 }, 'v0.9.4')).toBe(
      'Martin promoted the canary of v0.9.4 from 25% to 50%',
    );
    expect(summaryOf({ action: 'pause', release: 'r', weight: 50 }, 'a'.repeat(40))).toBe(
      'Martin paused the canary of aaaaaaa at 50%',
    );
  });
});
