/**
 * Martin's acts on a canary, as the panel draws them the moment the admin service records them (`release.controlled`),
 * before the line records what came of them at its next pass: an abort, a full promotion and a retry each show as under
 * way, with no control left that they made pointless, until the line's own record takes over. Promote to the next
 * step, Pause and Resume move the canary at once. And a judged step past its pause waits for its analysis, not a time.
 * From the try on the local cluster (2026-10-31), where each showed nothing for up to half a minute.
 */
import type { PayloadOf } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { actingKicker, actingWords, controlsOf, releases, waitsForAnalysis } from '../../web/src/projection/release.ts';
import { work } from './support.ts';

const started: PayloadOf<'release.started'> = {
  release: 'r1',
  version: 'v1.0.1',
  previous: 'v1.0.0',
  image: { digest: `sha256:${'b'.repeat(64)}`, signed: true, admitted: true },
  watched: true,
  steps: [
    { weight: 25, pauseSeconds: 180, analysis: true },
    { weight: 50, pauseSeconds: 180, analysis: true },
  ],
  dryRun: false,
};
const controlled = (action: PayloadOf<'release.controlled'>['action'], weight = 25, extra = {}) =>
  ({ release: 'r1', version: 'v1.0.1', action, weight, ...extra }) as PayloadOf<'release.controlled'>;
const SAID = 'Metric "latency" assessed Inconclusive due to inconclusive (2) > inconclusiveLimit (1)';
const judged = { name: 'latency', phase: 'inconclusive', value: 0.16, limit: 0, message: SAID } as const;
const steppedBad = {
  release: 'r1',
  version: 'v1.0.1',
  weight: 25,
  analysis: { phase: 'inconclusive', requests: 185, measures: [judged] },
  dryRun: false,
} satisfies PayloadOf<'canary.stepped'>;
const rolledBack = {
  release: 'r1',
  version: 'v1.0.1',
  restored: 'v1.0.0',
  weight: 25,
  reason: SAID,
  failed: [],
  dryRun: false,
  by: 'martin',
} satisfies PayloadOf<'release.rolled-back'>;

const at = (events: ReturnType<typeof work>, minute: number) => releases(events.events, [], events.at(minute)).at(-1);
const actions = (r: ReturnType<typeof at>) => (r ? controlsOf(r, false).map((c) => c.action) : []);

describe('an act of Martin’s the line has not recorded yet', () => {
  it('shows an abort of a canary judged bad at once, with nothing left to press, until the line records the rollback', () => {
    const one = work('1')
      .open()
      .add(1, 'release.started', 'rollouts', started)
      .add(4, 'canary.stepped', 'rollouts', steppedBad);
    expect(actions(at(one, 5))).toEqual(['promote-fully', 'abort']);
    one.add(6, 'release.controlled', 'martin', controlled('abort'));
    const aborting = at(one, 6.2);
    expect(aborting?.acting).toEqual({ action: 'abort', at: one.at(6), weight: 25, stop: false });
    expect(aborting?.end).toBeUndefined();
    expect(actions(aborting)).toEqual([]);
    if (!aborting?.acting) throw new Error('not acting');
    expect(actingKicker(aborting.acting)).toBe('Aborting at 25%');
    expect(actingWords(aborting, aborting.acting, 'martin', '09:06:00')).toBe(
      'You aborted the canary at 25%, at 09:06:00: Argo Rollouts sends all the traffic back to v1.0.0. Since the analysis judged it bad, it counts as a rollback. The line records it at its next pass.',
    );
    // The line's record takes over: the act is done, and Retry is offered.
    one.add(6.5, 'release.rolled-back', 'rollouts', rolledBack);
    const ended = at(one, 7);
    expect(ended?.acting).toBeUndefined();
    expect(ended?.end).toMatchObject({ kind: 'rolled-back', by: 'martin' });
    expect(actions(ended)).toEqual(['retry']);
  });

  it('shows a retry of a release that ended at once, until the line records its new start', () => {
    const one = work('1')
      .open()
      .add(1, 'release.started', 'rollouts', started)
      .add(4, 'canary.stepped', 'rollouts', steppedBad)
      .add(6, 'release.controlled', 'martin', controlled('abort'))
      .add(6.5, 'release.rolled-back', 'rollouts', rolledBack)
      .add(8, 'release.controlled', 'martin', controlled('retry', 0));
    const retrying = at(one, 8.2);
    expect(retrying?.end?.kind).toBe('rolled-back');
    expect(retrying?.acting).toEqual({ action: 'retry', at: one.at(8), weight: 0, stop: false });
    expect(actions(retrying)).toEqual([]);
    if (!retrying?.acting) throw new Error('not acting');
    expect(actingKicker(retrying.acting)).toBe('Starting again');
    expect(actingWords(retrying, retrying.acting, 'visitor', '09:08:00')).toBe(
      'Martin retried the release at 09:08:00: Argo Rollouts starts v1.0.1’s canary again from its first step. The line records it at its next pass.',
    );
    one.add(8.5, 'release.started', 'rollouts', started);
    const again = at(one, 9);
    expect(again?.end).toBeUndefined();
    expect(again?.acting).toBeUndefined();
    expect(again?.retried.map((e) => e.kind)).toEqual(['rolled-back']);
    expect(actions(again)).toEqual(['promote', 'promote-fully', 'pause', 'abort']);
  });

  it('shows a full promotion at once, until the line records it promoted', () => {
    const one = work('1')
      .open()
      .add(1, 'release.started', 'rollouts', started)
      .add(2, 'release.controlled', 'martin', controlled('promote-fully', 25, { to: 100 }));
    const promoting = at(one, 2.2);
    expect(promoting?.acting?.action).toBe('promote-fully');
    expect(actions(promoting)).toEqual([]);
    if (!promoting?.acting) throw new Error('not acting');
    expect(actingKicker(promoting.acting)).toBe('Promoting fully');
    one.add(2.5, 'release.promoted', 'rollouts', {
      release: 'r1',
      version: 'v1.0.1',
      previous: 'v1.0.0',
      watched: true,
      dryRun: false,
    } as PayloadOf<'release.promoted'>);
    expect(at(one, 3)).toMatchObject({ acting: undefined, end: { kind: 'promoted' } });
  });

  it('says a stop of the line’s abort is the line’s', () => {
    const one = work('1')
      .open()
      .add(1, 'release.started', 'rollouts', started)
      .add(2, 'line.stopped', 'martin', { reason: 'Canary abort test.' })
      .add(2, 'release.controlled', 'martin', controlled('abort', 25, { stop: true }));
    const r = at(one, 2.2);
    if (!r?.acting) throw new Error('not acting');
    expect(actingKicker(r.acting)).toBe('Stopping with the line at 25%');
    expect(actingWords(r, r.acting, 'martin', '09:02:00')).toBe(
      'Stop the line aborted the canary at 25%, at 09:02:00: Argo Rollouts sends all the traffic back to v1.0.0. The line records it at its next pass.',
    );
  });

  it('needs none for a pause, a resume or a promotion to the next step, which move the canary at once', () => {
    const one = work('1')
      .open()
      .add(1, 'release.started', 'rollouts', started)
      .add(2, 'release.controlled', 'martin', controlled('pause'));
    expect(at(one, 2.1)).toMatchObject({ acting: undefined, paused: { at: one.at(2), weight: 25 } });
    expect(actions(at(one, 2.1))).toContain('resume');
    one.add(3, 'release.controlled', 'martin', controlled('resume'));
    expect(at(one, 3.1)).toMatchObject({ acting: undefined, paused: undefined });
    one.add(4, 'release.controlled', 'martin', controlled('promote', 25, { to: 50 }));
    expect(at(one, 4.1)).toMatchObject({ acting: undefined, weight: 50 });
  });
});

describe('a judged step past its pause', () => {
  it('waits for its analysis to end, not for the time its pause ended', () => {
    const one = work('1').open().add(1, 'release.started', 'rollouts', started);
    const during = at(one, 3);
    expect(during?.until).toBe(one.at(4));
    expect(during && waitsForAnalysis(during, one.at(3))).toBe(false);
    // The journeys' Job is still running a minute and more after the pause: the step waits for it.
    const after = at(one, 6);
    expect(after?.step).toBe(0);
    expect(after && waitsForAnalysis(after, one.at(6))).toBe(true);
    // Not while Martin's pause holds it.
    one.add(6, 'release.controlled', 'martin', controlled('pause'));
    const held = at(one, 6.5);
    expect(held && waitsForAnalysis(held, one.at(6.5))).toBe(false);
  });
});
