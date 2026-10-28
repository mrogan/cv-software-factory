/**
 * What the canary bird does on each release event: which reaction each calls for, each copy of an event on another
 * work item heard once, and nothing on what the page held as it opened.
 */
import type { PayloadOf, PublicEvent } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { caged, hear, heard, type Reaction } from '../../web/src/projection/bird.ts';
import { lookVerdict, releases } from '../../web/src/projection/release.ts';
import { END, SAMPLES, work } from './support.ts';

const started = (release = 'r1', dryRun = false): PayloadOf<'release.started'> => ({
  release,
  version: 'v1.0.1',
  previous: 'v1.0.0',
  image: { digest: `sha256:${'b'.repeat(64)}`, signed: true, admitted: true },
  watched: true,
  steps: [
    { weight: 25, pauseSeconds: 180, analysis: true },
    { weight: 50, pauseSeconds: 180, analysis: true },
  ],
  dryRun,
});

type Measure = PayloadOf<'canary.measuring'>['measures'][number];
const measure = (name: string, second: number, phase: Measure['phase'] = 'successful'): Measure => ({
  name,
  phase,
  value: phase === 'failed' ? 0.05 : -0.05,
  limit: 0,
  at: new Date(Date.parse('2026-10-03T09:00:00Z') + second * 1000).toISOString(),
});
const look = (measures: Measure[], release = 'r1'): PayloadOf<'canary.measuring'> => ({
  release,
  version: 'v1.0.1',
  weight: 25,
  at:
    measures
      .map((m) => m.at)
      .sort()
      .at(-1) ?? '',
  measures,
  dryRun: false,
});
const stepped = (weight: number, phase: 'successful' | 'failed' | 'inconclusive' = 'successful') =>
  ({
    release: 'r1',
    version: 'v1.0.1',
    weight,
    analysis: { phase, requests: 225, measures: [] },
    dryRun: false,
  }) satisfies PayloadOf<'canary.stepped'>;
const ended = { release: 'r1', version: 'v1.0.1', restored: 'v1.0.0' };

/** Each event's reaction, heard in order from a bird in its cage. */
const reactions = (events: readonly PublicEvent[]) => {
  const watch = caged();
  return events.map((event) => hear(watch, event));
};

describe('the canary bird', () => {
  it('leaves for a start, hops for each look, sings a note more for each step, and trills home at the promotion', () => {
    const one = work('1')
      .open()
      .add(1, 'release.started', 'rollouts', started())
      .add(2, 'canary.measuring', 'rollouts', look([measure('errors', 120), measure('latency', 120)]))
      .add(3, 'canary.measuring', 'rollouts', look([measure('journeys', 180)]))
      .add(4, 'canary.stepped', 'rollouts', stepped(25))
      .add(7, 'canary.stepped', 'rollouts', stepped(50))
      .add(8, 'release.promoted', 'rollouts', {
        release: 'r1',
        version: 'v1.0.1',
        previous: 'v1.0.0',
        watched: true,
        dryRun: false,
      });
    expect(reactions(one.events)).toEqual<(Reaction | undefined)[]>([
      undefined,
      { kind: 'leave', paper: false },
      { kind: 'hop' },
      { kind: 'hop' },
      { kind: 'sing', step: 0 },
      { kind: 'sing', step: 1 },
      { kind: 'trill' },
    ]);
  });

  it('is a paper bird for a dry run', () => {
    const dry = work('1').add(1, 'release.started', 'rollouts', started('r1', true));
    expect(reactions(dry.events)).toEqual([{ kind: 'leave', paper: true }]);
  });

  it('sings a sour note for a look over its limit, never twice for the same measurement, and hops for a split look', () => {
    const errors = measure('errors', 120);
    const latency = measure('latency', 120, 'failed');
    const one = work('1')
      .add(1, 'release.started', 'rollouts', started())
      // The line read the analysis between its two writes: errors a pass before latency, each a look.
      .add(2.1, 'canary.measuring', 'rollouts', look([errors]))
      .add(2.6, 'canary.measuring', 'rollouts', look([errors, latency]));
    // The same look, recorded on the release's other work item a pass later.
    const two = work('2')
      .add(1, 'release.started', 'rollouts', started())
      .add(3, 'canary.measuring', 'rollouts', look([errors, latency]));
    const events = [...one.events, ...two.events].sort((a, b) => a.ts.localeCompare(b.ts));
    expect(reactions(events)).toEqual([
      { kind: 'leave', paper: false },
      undefined,
      { kind: 'hop' },
      { kind: 'sour' },
      undefined,
    ]);
    // The Canary panel keeps each measurement as the bird hears it: the failed latency once.
    const [r] = releases(events, [], one.at(3.5));
    if (!r) throw new Error('No release');
    expect(r.looks.flatMap((l) => l.measures.map((m) => m.name))).toEqual(['errors', 'latency']);
    expect(lookVerdict(r, 'latency').words).toBe('50 ms over · 1 of 2');
  });

  it('keels over at a rollback, and goes home quietly from an abort or an analysis error', () => {
    const rolled = work('1')
      .add(1, 'release.started', 'rollouts', started())
      .add(4, 'canary.stepped', 'rollouts', stepped(25, 'failed'))
      .add(4, 'release.rolled-back', 'rollouts', {
        ...ended,
        weight: 25,
        reason: 'Metric "latency" assessed Failed',
        failed: [],
        dryRun: false,
      });
    expect(reactions(rolled.events).slice(1)).toEqual([{ kind: 'sour' }, { kind: 'keel' }]);
    const aborted = work('1')
      .add(1, 'release.started', 'rollouts', started())
      .add(4, 'canary.stepped', 'rollouts', stepped(25, 'inconclusive'))
      .add(5, 'release.aborted', 'martin', { ...ended, by: 'martin', abortedAt: '2026-10-03T09:05:00Z' });
    expect(reactions(aborted.events).slice(1)).toEqual([undefined, { kind: 'home' }]);
  });

  it('sings for a step that waited for someone and then passed', () => {
    const waited = work('1')
      .add(1, 'release.started', 'rollouts', started())
      .add(4, 'canary.stepped', 'rollouts', stepped(25, 'inconclusive'))
      .add(6, 'canary.stepped', 'rollouts', stepped(25));
    expect(reactions(waited.events).slice(1)).toEqual([undefined, { kind: 'sing', step: 0 }]);
  });

  it('leaves again for a retry, and takes no notice of another release’s events or of copies of an end', () => {
    const abort = { ...ended, by: 'martin' as const, abortedAt: '2026-10-03T09:05:00Z' };
    const one = work('1')
      .add(1, 'release.started', 'rollouts', started())
      .add(2, 'canary.measuring', 'rollouts', look([measure('journeys', 120)], 'r0'))
      .add(5, 'release.aborted', 'martin', abort)
      .add(5.5, 'release.aborted', 'martin', abort)
      .add(6, 'release.started', 'rollouts', started())
      .add(7, 'canary.measuring', 'rollouts', look([measure('journeys', 420)]));
    expect(reactions(one.events)).toEqual([
      { kind: 'leave', paper: false },
      undefined,
      { kind: 'home' },
      undefined,
      { kind: 'leave', paper: false },
      { kind: 'hop' },
    ]);
  });

  it('has heard everything the page holds as it opens, so a copy that arrives after is no news', () => {
    // The samples end with v0.9.13 in flight, its 50% step's looks landed.
    const watch = heard(SAMPLES);
    expect(watch.release).toBeDefined();
    const last = SAMPLES.findLast((e) => e.type === 'canary.measuring');
    if (!last) throw new Error('No look in the samples');
    expect(hear(watch, { ...last, seq: last.seq + 10_000, ts: new Date(END).toISOString() })).toBeUndefined();
  });
});
