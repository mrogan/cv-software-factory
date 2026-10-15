/**
 * Releases and the Canary panel (the design system's README, "Shipping"): from the samples' releases, on work items
 * and on the line, and from hand-made ones for the steps the samples do not take.
 */
import type { PayloadOf } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { release as policy } from '../../../../policy/release.ts';
import { project, upTo } from '../../web/src/projection/index.ts';
import { type Card, timeline } from '../../web/src/projection/reel.ts';
import { type Failed, MEASURES, ownWords, type Release, releases, sawOf } from '../../web/src/projection/release.ts';
import { END, SAMPLES, work } from './support.ts';

const at = (iso: string) => Date.parse(iso);
/** The build of one of Martin's commits that rolled back on Monday evening, as v0.9.9 had (the samples' `line.ts`). */
const EVENING = 'efef168f4eec299dfc27c8fc78477ce28379b38d';
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
    expect(shown(END).view.panels.release.rows).toContainEqual(
      expect.objectContaining({ item: '1321', note: 'Needs you · waiting for Martin’s deploy', tone: 'attn' }),
    );
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
      end: {
        kind: 'rolled-back',
        weight: 25,
        ticket: { number: '1308', title: 'Slow responses in a canary release', how: 'opened' },
      },
    });
    expect(view.panels.release.rows).toContainEqual(
      expect.objectContaining({ item: 'v0.9.9', note: 'rolled back at 25% · opened #1308', tone: 'attn' }),
    );
  });

  it('links a later rollback whose signal joined that ticket, still open, to it, saying so', () => {
    const { view, canary } = shown(at('2026-10-05T17:45:00Z'));
    expect(canary.state === 'shown' && canary.release).toMatchObject({
      version: EVENING,
      end: { kind: 'rolled-back', weight: 25, ticket: { number: '1308', how: 'joined' } },
    });
    expect(view.panels.release.rows).toContainEqual(
      expect.objectContaining({ item: EVENING, note: 'rolled back at 25% · added it to #1308', tone: 'attn' }),
    );
  });

  it('draws the abort the line recorded, when Argo Rollouts acted on it, at the step the canary had reached', () => {
    const { view, canary } = shown(at('2026-10-06T06:40:00Z'));
    expect(canary.state === 'shown' && canary.release).toMatchObject({
      version: 'v0.9.11',
      end: { kind: 'aborted', by: 'stop', at: at('2026-10-06T06:35:11Z'), weight: 50 },
    });
    expect(view.panels.release.rows[0]).toMatchObject({ item: 'v0.9.11', note: 'stopped with the line at 50%' });
    // Starting the line again does not resume it; Martin's retry does, and his own abort ends it again.
    expect(shown(at('2026-10-06T06:50:30Z')).canary).toMatchObject({ release: { end: { by: 'stop' } } });
    const retried = shown(at('2026-10-06T06:55:00Z')).canary;
    expect(retried.state === 'shown' && retried.release).toMatchObject({
      startedAt: at('2026-10-06T06:51:00Z'),
      end: { kind: 'aborted', by: 'martin', at: at('2026-10-06T06:53:02Z'), weight: 25 },
      retried: [{ kind: 'aborted', by: 'stop', weight: 50 }],
    });
  });

  it('draws a dry run as the dry run records it, and never moves the app’s version for it', () => {
    const { canary } = shown(at('2026-10-05T13:09:40Z'));
    expect(canary.state === 'shown' && canary.release).toMatchObject({ dryRun: true, image: undefined, weight: 50 });
    const after = project(SAMPLES, at('2026-10-05T13:30:00Z'));
    expect(after.cards.find((c) => c.number === '1310')?.appVersion).toBe('v0.9.10');
  });

  it('draws one release for a release that carries two work items', () => {
    const one = releases(SAMPLES, [], END).filter((r) => r.id === 'tqntrr4wg7-908');
    expect(one).toHaveLength(1);
    expect(one[0]?.items.map((i) => i.number)).toEqual(['1304', '1306']);
    expect(one[0]?.measured.map((m) => m.weight)).toEqual([25, 50]);
  });

  it('says there is no release before the first', () => {
    expect(shown(at('2026-09-29T08:00:00Z')).canary).toEqual({ state: 'none' });
  });
});

describe('the timeline, from the samples', () => {
  const view = project(SAMPLES, END);
  const { cards, timeline } = view;
  const mark = (version: string) => timeline.versions.find((v) => v.version === version);
  const place = (number: string) => timeline.positions[cards.findIndex((c) => c.number === number)] ?? -1;

  it('marks every version the app was left on, in order, a rollback and a stop struck through', () => {
    expect(timeline.versions.map((v) => (v.rolledBack ? `~${v.version}~` : v.version))).toEqual([
      ...['v0.8.4', 'v0.8.5', 'v0.9.0', '~v0.9.1~', 'v0.9.2', 'v0.9.3', 'v0.9.5', 'v0.9.7', 'v0.9.8'],
      ...['~v0.9.9~', 'v0.9.10', `~${EVENING}~`, '~v0.9.11~', 'v0.9.12'],
    ]);
    const places = timeline.versions.map((v) => v.at);
    expect(places).toEqual([...places].sort((a, b) => a - b));
  });

  it('marks a release with no work item at its time, between the cards either side of it', () => {
    // v0.9.9 rolled back after v0.9.8 shipped #1304 and before v0.9.10 shipped #1306, though #1306 opened before it.
    expect(mark('v0.9.9')).toMatchObject({ card: undefined });
    expect(mark('v0.9.9')?.at).toBeGreaterThan(place('1304'));
    expect(mark('v0.9.9')?.at).toBeLessThan(place('1306'));
    // v0.9.11 and v0.9.12 went out on Tuesday morning, before #1314 opened, each in a place of its own.
    const tuesday = timeline.days.at(-1)?.at ?? 0;
    for (const version of ['v0.9.11', 'v0.9.12']) {
      expect(mark(version)?.at).toBeGreaterThanOrEqual(tuesday);
      expect(mark(version)?.at).toBeLessThan(place('1314'));
    }
    expect(mark('v0.9.11')?.at).toBeLessThan(mark('v0.9.12')?.at ?? 0);
    const alone = releases(SAMPLES, [], END).filter((r) => r.end && !r.dryRun && !r.items.length);
    expect(alone.map((r) => r.version)).toEqual(['v0.9.9', EVENING, 'v0.9.11', 'v0.9.12']);
    expect(new Set([...timeline.positions, ...timeline.versions.map((v) => v.at)]).size).toBe(
      cards.length + alone.length,
    );
  });

  it('marks a release under the first card whose latest release it is, whatever came of the card since', () => {
    // v0.9.8 carried #1304 and #1306; #1306 went again in v0.9.10, and has been sent back to Plan since.
    expect(mark('v0.9.8')?.card).toBe(cards.findIndex((c) => c.number === '1304'));
    expect(mark('v0.9.10')?.card).toBe(cards.findIndex((c) => c.number === '1306'));
  });

  it('marks nothing for a dry run, or for a release still in flight', () => {
    const dryRun = releases(SAMPLES, [], END).find((r) => r.dryRun);
    expect(dryRun?.end?.kind).toBe('promoted');
    expect(timeline.versions.map((v) => v.version)).not.toContain(dryRun?.version);
    expect(mark('v0.9.13')).toBeUndefined();
  });

  it('agrees with the line under it: a work item done with is on the last version marked by its place', () => {
    // An open work item's line says the version the app is on now.
    const open = new Set(['in-progress', 'waiting', 'needs-you', 'held']);
    for (const [i, card] of cards.entries()) {
      if (open.has(card.outcome)) continue;
      const kept = timeline.versions.filter((v) => !v.rolledBack && v.at <= (timeline.positions[i] ?? 0)).at(-1);
      expect([card.number, card.appVersion]).toEqual([card.number, kept?.version]);
    }
  });
});

describe('the timeline, from hand-made releases', () => {
  const hour = 3_600_000;
  const monday = at('2026-10-05T09:00:00Z');
  const card = (number: string, hours: number) => ({ number, startedAt: monday + hours * hour }) as Card;
  const shipped = (version: string, items: string[], hours: number, kind = 'promoted') =>
    ({
      version,
      items: items.map((number) => ({ number })),
      dryRun: false,
      end: { kind, at: monday + hours * hour },
    }) as Release;
  const marks = (cards: Card[], all: Release[]) => {
    const { positions, versions } = timeline(cards, all);
    return [
      ...cards.map((c, i) => ({ name: c.number, at: positions[i] ?? -1 })),
      ...versions.map((v) => ({ name: v.rolledBack ? `~${v.version}~` : v.version, at: v.at })),
    ]
      .sort((a, b) => a.at - b.at)
      .map((m) => m.name);
  };

  it('gives a release whose work item went again in a later one a place of its own, at its time', () => {
    const cards = [card('1', 0), card('2', 5)];
    const all = [shipped('v1', ['1'], 1, 'rolled-back'), shipped('v2', ['1'], 2)];
    expect(marks(cards, all)).toEqual(['~v1~', '1', 'v2', '2']);
    // And one whose work items are on no card, as if it carried none.
    expect(marks(cards, [...all, shipped('v3', ['9'], 6)])).toEqual(['~v1~', '1', 'v2', '2', 'v3']);
  });

  it('gives a card’s release a place of its own when it shipped before an earlier card’s', () => {
    // #1 started first and shipped v2 after #2 shipped v1.
    const cards = [card('1', 0), card('2', 1)];
    expect(marks(cards, [shipped('v1', ['2'], 2), shipped('v2', ['1'], 3)])).toEqual(['v1', '1', 'v2', '2']);
    // v1 carried both, and v2 carried #1 again.
    expect(marks(cards, [shipped('v1', ['1', '2'], 2), shipped('v2', ['1'], 3)])).toEqual(['v1', '1', 'v2', '2']);
  });

  it('keeps an attempt’s mark while its retry is in flight', () => {
    const retry = {
      ...shipped('v1', ['1'], 1, 'rolled-back'),
      end: undefined,
      retried: [{ kind: 'rolled-back', at: monday + hour }],
    };
    expect(marks([card('1', 0)], [retry as Release])).toEqual(['1', '~v1~']);
  });

  it('keeps the versions in the order the app’s changed, where a card shipped after one that started later', () => {
    // #1 started first and shipped last; #2 started before the release with no work item, and has not shipped.
    const cards = [card('1', 0), card('2', 1)];
    expect(marks(cards, [shipped('v1', [], 2), shipped('v2', ['1'], 3)])).toEqual(['v1', '1', 'v2', '2']);
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

  it('lists a merge waiting for a deploy as Martin’s, and after a rollback as waiting for his next', () => {
    const deploy = { stage: 'release', kind: 'approval', cause: 'deploy', reason: 'Waits for a deploy' } as const;
    const one = work('1')
      .open()
      .add(1, 'pull-request.merged', 'martin', { number: 2, commit: 'b'.repeat(40), by: 'martin' })
      .add(1, 'hold.started', 'factory', deploy);
    const note = (t: number) => project(one.events, t).panels.release.rows.find((r) => r.item === '1')?.note;
    expect(note(one.at(2))).toBe('Needs you · waiting for Martin’s deploy');
    one
      .add(3, 'release.started', 'rollouts', started(twoSteps))
      .add(6, 'release.rolled-back', 'rollouts', rolledBack)
      .add(6, 'hold.started', 'factory', deploy);
    // The release that carries it ends the wait.
    expect(note(one.at(4))).not.toMatch(/^Needs you/);
    expect(note(one.at(7))).toBe('Needs you · rolled back, waiting for Martin’s next deploy');
    // The card and the sheet say so too, with the release that rolled back.
    const picture = (t: number) => project(one.events, t).cards.find((c) => c.number === '1')?.picture;
    expect(picture(one.at(2))).toMatchObject({ type: 'deploy', ended: undefined });
    expect(picture(one.at(7))).toMatchObject({ type: 'deploy', ended: { version: 'v1.0.1', aborted: undefined } });
    // A new fix, merged after the rollback, waits for a deploy as the first did.
    one
      .add(8, 'pull-request.merged', 'martin', { number: 3, commit: 'c'.repeat(40), by: 'martin' })
      .add(8, 'hold.started', 'factory', deploy);
    expect(note(one.at(9))).toBe('Needs you · waiting for Martin’s deploy');
    expect(picture(one.at(9))).toMatchObject({ type: 'deploy', ended: undefined });
  });

  it('lists a merge whose release Martin aborted as waiting for his retry or his next deploy', () => {
    const deploy = { stage: 'release', kind: 'approval', cause: 'deploy', reason: 'Waits for a deploy' } as const;
    const one = work('1')
      .open()
      .add(1, 'pull-request.merged', 'martin', { number: 2, commit: 'b'.repeat(40), by: 'martin' })
      .add(3, 'release.started', 'rollouts', started(twoSteps));
    const abortedAt = new Date(one.at(5)).toISOString();
    one
      .add(6, 'release.aborted', 'martin', {
        release: 'r1',
        version: 'v1.0.1',
        restored: 'v1.0.0',
        abortedAt,
        by: 'martin',
      })
      .add(6, 'hold.started', 'factory', deploy);
    const view = project(one.events, one.at(7));
    expect(view.panels.release.rows.find((r) => r.item === '1')?.note).toBe(
      'Needs you · aborted by Martin, waiting for his retry or next deploy',
    );
    const card = view.cards.find((c) => c.number === '1');
    expect(card?.picture).toMatchObject({
      type: 'deploy',
      ended: { at: one.at(5), version: 'v1.0.1', aborted: 'martin' },
    });
    expect(card?.versions).toMatchObject({ rolledBack: false, aborted: 'martin', onCanary: false });
  });

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

  it('reads an older history’s stop as Stop the line’s abort of the newest release, until it records its own end', () => {
    const one = work('1')
      .open()
      .add(1, 'release.started', 'rollouts', started(twoSteps))
      .add(5, 'release.started', 'rollouts', { ...started(twoSteps), release: 'r2', version: 'v1.0.2' })
      .add(6, 'line.stopped', 'martin', { reason: 'Stopped' });
    const [older, newer] = releases(one.events, [], one.at(7));
    expect(older?.end).toBeUndefined();
    expect(newer?.end).toEqual({ kind: 'aborted', by: 'stop', at: one.at(6), weight: 25 });
    // The abort the line records a pass later is the end, when Argo Rollouts acted on it.
    const abortedAt = new Date(one.at(6) + 1000).toISOString();
    one.add(7, 'release.aborted', 'martin', {
      release: 'r2',
      version: 'v1.0.2',
      restored: 'v1.0.0',
      abortedAt,
      by: 'stop',
    });
    expect(releases(one.events, [], one.at(8))[1]?.end).toEqual({
      kind: 'aborted',
      by: 'stop',
      at: one.at(6) + 1000,
      weight: 25,
    });
    // A history that records aborts reads no stop as one: a release the line recorded no abort for stays unfinished.
    one
      .add(9, 'release.started', 'rollouts', { ...started(twoSteps), release: 'r3', version: 'v1.0.3' })
      .add(10, 'line.stopped', 'martin', { reason: 'Stopped' });
    expect(releases(one.events, [], one.at(11))[2]?.end).toBeUndefined();
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

describe('what the analysis saw of a measure that failed', () => {
  const reason = 'Metric "latency" assessed Failed due to failed (2) > failureLimit (1)';
  const failed = (name: string, value: number | null, limit: number | null, message?: string): Failed => ({
    name,
    phase: 'failed',
    value,
    limit,
    ...(message ? { message } : {}),
  });

  it('says each figure against its limit, in the analysis’s terms', () => {
    expect(sawOf(failed('enough-requests', 62, 100), reason)).toBe('62 requests to the canary, against at least 100');
    expect(sawOf(failed('errors', 0.024, 0.01), reason)).toBe(
      '5xx share 2.40 points above the baseline’s, against at most 1.00 points',
    );
    expect(sawOf(failed('latency', 0.273, 0), reason)).toBe('p99 273 ms over its limit');
    // Any excess fails, so a fraction of a millisecond is not said as none.
    expect(sawOf(failed('latency', 0.0004, 0), reason)).toBe('p99 1 ms over its limit');
    // The limit is what the value is held to: the excess over it is what is said.
    expect(sawOf(failed('latency', 0.273, 0.1), reason)).toBe('p99 173 ms over its limit');
    // A limit the analysis did not record is not said.
    expect(sawOf(failed('errors', 0.024, null), reason)).toBe('5xx share 2.40 points above the baseline’s');
    expect(sawOf(failed('other', 3, null), reason)).toBe('3');
  });

  it('says when there was nothing to compare, and lets the journeys say what they saw', () => {
    // Argo Rollouts' words for an earlier analysis's failure are not the measure's own either.
    const earlier = 'Metric "latency" assessed Failed due to failed (1) > failureLimit (0)';
    expect(sawOf(failed('latency', null, 0, earlier), reason)).toBe(
      'no figures to compare, which counts as infinitely worse',
    );
    // Nor are they said beside what the analysis saw.
    expect(ownWords(earlier, reason)).toBeUndefined();
    expect(ownWords('Prometheus did not answer', reason)).toBe('Prometheus did not answer');
    expect(sawOf(failed('latency', null, 0, reason), reason)).toBe(
      'no figures to compare, which counts as infinitely worse',
    );
    expect(sawOf(failed('journeys', null, null, 'checkout failed on the canary twice'), reason)).toBe(
      'checkout failed on the canary twice',
    );
    expect(sawOf(failed('journeys', null, null, reason), reason)).toBe(
      'a check that passed on the baseline failed here',
    );
  });
});
