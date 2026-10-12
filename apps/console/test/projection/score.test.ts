/**
 * The scoreboard beside the app's name: what `score.updated` said last by t, as it said it. It is off when the
 * scoreboard has no answer key, and absent when it has never published (an older store, the replay site).
 */
import type { PayloadOf, PublicEvent } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { project } from '../../web/src/projection/index.ts';
import { END, SAMPLES, work } from './support.ts';

type Score = PayloadOf<'score.updated'>;

/** The scoreboard's events, at minutes from the start, beside one work item; the scoreboard's are on the line. */
function scored(...scores: [minute: number, score: Score][]): PublicEvent[] {
  const builder = work('3001').open();
  for (const [minute, score] of scores) builder.add(minute, 'score.updated', 'scoreboard', score);
  return builder.events.map((event) => (event.type === 'score.updated' ? { ...event, work_item: null } : event));
}

const at = work('3001').at;
const first: Score = { keyed: true, entries: 30, found: 1, verified: 0, medianMs: null };
const later: Score = { keyed: true, entries: 30, found: 3, verified: 2, medianMs: 2_430_000 };

describe('the scoreboard', () => {
  it('is absent when the scoreboard has never published', () => {
    expect(project(work('3001').open().events, at(1)).score).toBeUndefined();
  });

  it('is off when the scoreboard has no answer key', () => {
    expect(project(scored([1, { keyed: false }]), at(2)).score).toEqual({ keyed: false });
  });

  it('shows the figures it published last by t, and nothing it had not published yet', () => {
    const events = scored([1, { keyed: false }], [2, first], [5, later]);
    expect(project(events, at(0.5)).score).toBeUndefined();
    expect(project(events, at(3)).score).toEqual(first);
    expect(project(events, at(6)).score).toEqual(later);
  });

  it('follows a figure down, as a reopened ticket takes its verified fix away', () => {
    const fewer: Score = { ...later, verified: 1, medianMs: 1_800_000 };
    expect(project(scored([2, later], [5, fewer]), at(6)).score).toEqual(fewer);
  });
});

describe('the samples’ scoreboard', () => {
  const scoreAt = (iso: string) => project(SAMPLES, Date.parse(iso)).score;

  it('is off before it has a key, then counts from nothing, then has figures by the end', () => {
    expect(scoreAt('2026-09-29T07:30:00Z')).toEqual({ keyed: false });
    expect(scoreAt('2026-09-29T09:00:00Z')).toEqual({
      keyed: true,
      entries: 30,
      found: 0,
      verified: 0,
      medianMs: null,
    });
    expect(project(SAMPLES, END).score).toMatchObject({ keyed: true, medianMs: expect.any(Number) });
  });

  it('is absent before the scoreboard first publishes', () => {
    expect(scoreAt('2026-09-29T07:00:00Z')).toBeUndefined();
  });
});
