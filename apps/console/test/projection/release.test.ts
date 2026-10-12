/**
 * Releases and the Canary panel (the design system's README, "Shipping"): from the samples' releases, on work items
 * and on the line, and from hand-made ones for the steps the samples do not take.
 */
import type { PayloadOf } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { release as policy } from '../../../../policy/release.ts';
import { project, upTo } from '../../web/src/projection/index.ts';
import { MEASURES, releases } from '../../web/src/projection/release.ts';
import { END, SAMPLES, work } from './support.ts';

const at = (iso: string) => Date.parse(iso);
const shown = (t: number) => {
  const view = project(SAMPLES, t);
  return { view, canary: view.canary, station: view.stations.find((s) => s.stage === 'release') };
};

describe('the Canary panel, from the samples', () => {
  it('draws the release in flight at the step it is measuring, not the last one measured', () => {
    const { canary, station } = shown(END);
    expect(canary.state).toBe('shown');
    if (canary.state !== 'shown') return;
    expect(canary.release).toMatchObject({ version: 'v0.9.13', weight: 50, step: 1, end: undefined });
    expect(canary.release.items.map((i) => i.number)).toEqual(['1314']);
    expect(canary.release.steps.map((s) => s.weight)).toEqual([25, 50, 100]);
    expect(canary.release.until).toBe(at('2026-10-06T14:24:00Z'));
    // The station works on the canary while a merge waits for Martin's deploy.
    expect(station).toMatchObject({ status: 'working', beacon: 'needs-you', figure: '50% · 1 waiting' });
  });

  it('draws a release with no work item, and Release counts it and lists it by its version', () => {
    const { view, canary, station } = shown(at('2026-10-06T07:04:00Z'));
    expect(canary.state === 'shown' && canary.release).toMatchObject({ version: 'v0.9.12', items: [], weight: 50 });
    expect(station).toMatchObject({ status: 'working', figure: '50%' });
    expect(view.panels.release.rows[0]).toMatchObject({ item: 'v0.9.12', release: true, note: 'canary at 50%' });
  });

  it('keeps a promoted release in full for a quarter of an hour, then folds it to one line', () => {
    expect(shown(at('2026-10-06T07:10:00Z')).canary).toMatchObject({
      state: 'shown',
      release: { end: { kind: 'promoted' } },
    });
    expect(shown(at('2026-10-06T07:10:00Z')).station?.status).toBe('passing');
    expect(shown(at('2026-10-06T08:00:00Z')).canary).toMatchObject({ state: 'idle', release: { version: 'v0.9.12' } });
  });

  it('links a rollback before any step was measured to the ticket its signal opened', () => {
    const { view, canary } = shown(at('2026-10-05T10:25:00Z'));
    expect(canary.state === 'shown' && canary.release).toMatchObject({
      version: 'v0.9.9',
      measured: [],
      end: { kind: 'rolled-back', weight: 25, ticket: { number: '1308', title: 'Slow responses in a canary release' } },
    });
    expect(view.panels.release.rows).toContainEqual(
      expect.objectContaining({ item: 'v0.9.9', note: 'rolled back at 25% · opened #1308', tone: 'attn' }),
    );
  });

  it('infers a stop from the line stopping while a release had not ended, at the step it had reached', () => {
    const { canary } = shown(at('2026-10-06T06:40:00Z'));
    expect(canary.state === 'shown' && canary.release).toMatchObject({
      version: 'v0.9.11',
      end: { kind: 'stopped', at: at('2026-10-06T06:35:10Z'), weight: 50 },
    });
    // Starting the line again does not resume it.
    expect(shown(at('2026-10-06T06:55:00Z')).canary).toMatchObject({ release: { end: { kind: 'stopped' } } });
  });

  it('draws a dry run as the dry run records it, and never moves the shop’s version for it', () => {
    const { canary } = shown(at('2026-10-05T13:09:40Z'));
    expect(canary.state === 'shown' && canary.release).toMatchObject({ dryRun: true, image: undefined, weight: 50 });
    const after = project(SAMPLES, at('2026-10-05T13:30:00Z'));
    expect(after.cards.find((c) => c.number === '1310')?.shopVersion).toBe('v0.9.10');
  });

  it('draws one release for a release that carries two work items', () => {
    const one = releases(SAMPLES, [], END).filter((r) => r.id === 'tqntrr4wg7');
    expect(one).toHaveLength(1);
    expect(one[0]?.items.map((i) => i.number)).toEqual(['1304', '1306']);
    expect(one[0]?.measured.map((m) => m.weight)).toEqual([25, 50]);
  });

  it('says there is no release before the first', () => {
    expect(shown(at('2026-09-29T08:00:00Z')).canary).toEqual({ state: 'none' });
  });
});

describe('a release’s steps', () => {
  const started = (steps: PayloadOf<'release.started'>['steps']): PayloadOf<'release.started'> => ({
    release: 'r1',
    version: 'v1.0.1',
    previous: 'v1.0.0',
    image: { digest: `sha256:${'b'.repeat(64)}`, signed: true, admitted: true },
    watched: true,
    steps,
    dryRun: false,
  });
  const stepped = (weight: number): PayloadOf<'canary.stepped'> => ({
    release: 'r1',
    version: 'v1.0.1',
    weight,
    analysis: { phase: 'successful', requests: 225, measures: [] },
    dryRun: false,
  });

  it('moves past a step the analysis does not judge when its pause runs out', () => {
    const one = work('1')
      .open()
      .add(
        1,
        'release.started',
        'rollouts',
        started([
          { weight: 10, pauseSeconds: 120, analysis: false },
          { weight: 50, pauseSeconds: null, analysis: true },
        ]),
      );
    expect(releases(one.events, [], one.at(2))[0]).toMatchObject({ step: 0, weight: 10, until: one.at(3) });
    // Past the pause, at a step that waits for someone: no end to wait for.
    expect(releases(one.events, [], one.at(4))[0]).toMatchObject({ step: 1, weight: 50, until: undefined });
  });

  const rolledBack: PayloadOf<'release.rolled-back'> = {
    release: 'r1',
    version: 'v1.0.1',
    restored: 'v1.0.0',
    weight: 25,
    reason: 'Metric "errors" assessed Failed',
    failed: [],
    dryRun: false,
  };
  const twoSteps = [
    { weight: 25, pauseSeconds: 180, analysis: true },
    { weight: 50, pauseSeconds: 180, analysis: true },
  ];

  it('goes again from its first step when it is retried after a rollback', () => {
    const one = work('1')
      .open()
      .add(1, 'release.started', 'rollouts', started(twoSteps))
      .add(3, 'release.rolled-back', 'rollouts', rolledBack)
      .add(10, 'release.started', 'rollouts', started(twoSteps))
      .add(13, 'canary.stepped', 'rollouts', stepped(25));
    const [r] = releases(one.events, [], one.at(14));
    expect(r).toMatchObject({ startedAt: one.at(10), end: undefined, weight: 50, step: 1 });
    expect(r?.items.map((i) => i.number)).toEqual(['1']);
    // The sheet says how the attempt it replaced ended.
    expect(r?.retried).toEqual([expect.objectContaining({ kind: 'rolled-back', at: one.at(3), weight: 25 })]);
  });

  it('holds at a step the analysis could not judge, or left for someone to decide', () => {
    for (const phase of ['error', 'inconclusive'] as const) {
      const one = work('1')
        .open()
        .add(1, 'release.started', 'rollouts', started(twoSteps))
        .add(4, 'canary.stepped', 'rollouts', { ...stepped(25), analysis: { phase, requests: 225, measures: [] } });
      expect(releases(one.events, [], one.at(9))[0]).toMatchObject({ step: 0, weight: 25, until: undefined });
    }
  });

  it('stops only the newest release with the line, not one a newer release left behind', () => {
    const one = work('1')
      .open()
      .add(1, 'release.started', 'rollouts', started(twoSteps))
      .add(5, 'release.started', 'rollouts', { ...started(twoSteps), release: 'r2', version: 'v1.0.2' })
      .add(6, 'line.stopped', 'martin', { reason: 'Stopped' });
    const [older, newer] = releases(one.events, [], one.at(7));
    expect(older?.end).toBeUndefined();
    expect(newer?.end).toMatchObject({ kind: 'stopped', weight: 25 });
  });

  it('matches a step measured to the judged step at its weight, when the plan holds the weight twice', () => {
    const one = work('1')
      .open()
      .add(
        1,
        'release.started',
        'rollouts',
        started([
          { weight: 20, pauseSeconds: 60, analysis: false },
          { weight: 20, pauseSeconds: 180, analysis: true },
          { weight: 60, pauseSeconds: 180, analysis: true },
        ]),
      )
      .add(5, 'canary.stepped', 'rollouts', stepped(20));
    expect(releases(one.events, [], one.at(6))[0]).toMatchObject({ step: 2, weight: 60, until: one.at(8) });
  });

  it('adds all of the traffic after the steps, unless they list it', () => {
    const listed = work('1')
      .open()
      .add(
        1,
        'release.started',
        'rollouts',
        started([
          { weight: 50, pauseSeconds: 60, analysis: true },
          { weight: 100, pauseSeconds: 60, analysis: true },
        ]),
      );
    expect(releases(listed.events, [], listed.at(1))[0]?.steps.map((s) => s.weight)).toEqual([50, 100]);
  });

  it('draws the steps measured, then all of the traffic, for a release that recorded none', () => {
    const one = work('1')
      .open()
      .add(1, 'release.started', 'rollouts', started(null))
      .add(4, 'canary.stepped', 'rollouts', stepped(25));
    const [r] = releases(upTo(one.events, one.at(1)), [], one.at(1));
    expect(r).toMatchObject({ planned: false, weight: 0, step: -1 });
    const [later] = releases(one.events, [], one.at(5));
    expect(later?.steps.map((s) => s.weight)).toEqual([25, 100]);
    expect(later).toMatchObject({ weight: 25, until: undefined });
    expect(project(one.events, one.at(1)).stations.find((s) => s.stage === 'release')?.figure).toBe('starting');
  });
});

it('keeps the measures’ rules in the policy’s terms', () => {
  const words = Object.fromEntries(MEASURES.map(([name, , rule]) => [name, rule]));
  expect(words['enough-requests']).toContain(`at least ${policy.minRequests} `);
  expect(policy.errors.maxAbove).toBe(0.01); // "a point above"
  expect(words.errors).toContain('a point above');
  expect(policy.latency).toMatchObject({ percentile: 0.99, maxRatioAbove: 0.25, minSecondsAbove: 0.1 });
  expect(words.latency).toBe('p99 · fails a quarter and 100 ms above');
  expect(policy.background.failures).toBe(2);
  expect(words.journeys).toContain('twice');
});
