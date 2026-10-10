import type { PublicEvent } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { project } from '../../web/src/projection/index.ts';
import { PASSING_MS, RETURNING_MS, whileSending } from '../../web/src/projection/line.ts';
import { payloads, work } from './support.ts';

const gatesStatus = (events: PublicEvent[], t: number) =>
  project(events, t).stations.find((s) => s.stage === 'gates')?.status;

// The design system's six rules for a station's state, one case each, in order of precedence.
describe('a station’s state', () => {
  const at = work('1').at;

  it.each([
    [
      'failed: an item failed in the stage and nothing has happened since',
      work('1')
        .open()
        .add(1, 'gates.started', 'actions', payloads.gatesStarted)
        .add(3, 'gates.finished', 'actions', payloads.gatesFailed).events,
      at(4),
      'failed',
    ],
    [
      'blocked: an item waits on a human',
      work('1')
        .open()
        .add(1, 'gates.started', 'actions', payloads.gatesStarted)
        .add(3, 'gates.finished', 'actions', payloads.gatesFailed)
        .add(3.1, 'hold.started', 'factory', { stage: 'gates', kind: 'held', cause: 'gates', reason: 'Tests removed' })
        .events,
      at(4),
      'blocked',
    ],
    [
      'returning: an item was sent upstream in the last few minutes',
      work('1')
        .open()
        .add(1, 'gates.started', 'actions', payloads.gatesStarted)
        .add(3, 'gates.finished', 'actions', payloads.gatesFailed)
        .add(3.5, 'work.returned', 'factory', { from: 'gates', to: 'build', reason: 'A check failed' }).events,
      at(3.5) + RETURNING_MS - 1000,
      'returning',
    ],
    [
      'working: an item is in progress in the stage',
      work('1').open().add(1, 'gates.started', 'actions', payloads.gatesStarted).events,
      at(2),
      'working',
    ],
    [
      'passing: the most recent item left the stage, and nothing is in progress',
      work('1')
        .open()
        .add(1, 'gates.started', 'actions', payloads.gatesStarted)
        .add(3, 'gates.finished', 'actions', payloads.gatesPassed)
        .add(4, 'review.submitted', 'reviewer', { pullRequest: 7, verdict: 'approved', note: 'Fine', findings: [] })
        .events,
      at(4) + PASSING_MS - 1000,
      'passing',
    ],
    [
      'idle: otherwise',
      work('1')
        .open()
        .add(1, 'gates.started', 'actions', payloads.gatesStarted)
        .add(3, 'gates.finished', 'actions', payloads.gatesPassed)
        .add(4, 'review.submitted', 'reviewer', { pullRequest: 7, verdict: 'approved', note: 'Fine', findings: [] })
        .events,
      at(4) + PASSING_MS + 1000,
      'idle',
    ],
  ])('%s', (_rule, events, t, status) => {
    expect(gatesStatus(events, t)).toBe(status);
  });

  // Work item 1 stops at Gates while work item 2 runs there: the station stays at work, and its beacon is lit.
  describe('with another item in progress beside one that', () => {
    const running = work('2').open().add(2, 'gates.started', 'actions', payloads.gatesStarted).events;
    const failing = work('1')
      .open()
      .add(1, 'gates.started', 'actions', payloads.gatesStarted)
      .add(3, 'gates.finished', 'actions', payloads.gatesFailed);
    const gates = (events: PublicEvent[], t: number) =>
      project(
        [...events, ...running].sort((a, b) => a.ts.localeCompare(b.ts)),
        t,
      ).stations.find((s) => s.stage === 'gates');
    const held = () =>
      work('1')
        .open()
        .add(1, 'gates.started', 'actions', payloads.gatesStarted)
        .add(3, 'gates.finished', 'actions', payloads.gatesFailed)
        .add(3.1, 'hold.started', 'factory', { stage: 'gates', kind: 'held', cause: 'gates', reason: 'Tests removed' });

    it('failed, works on with a failed beacon', () => {
      expect(gates(failing.events, at(4))).toMatchObject({ status: 'working', beacon: 'failed', figure: '2 PRs' });
    });

    it('waits on a human, works on with a needs-you beacon, and counts what is held', () => {
      expect(gates(held().events, at(4))).toMatchObject({ status: 'working', beacon: 'needs-you', figure: '1 held' });
    });

    it('waits on a human, keeps its beacon while it sends a third back', () => {
      const sent = work('3')
        .open()
        .add(1, 'gates.started', 'actions', payloads.gatesStarted)
        .add(3, 'gates.finished', 'actions', payloads.gatesFailed)
        .add(3.5, 'work.returned', 'factory', { from: 'gates', to: 'build', reason: 'A check failed' }).events;
      expect(gates([...held().events, ...sent], at(4))).toMatchObject({ status: 'returning', beacon: 'needs-you' });
    });

    it('waits on a human, is blocked with no beacon under Stop the line', () => {
      const stop = {
        ...(held().events[0] as PublicEvent),
        ts: new Date(at(3.5)).toISOString(),
        work_item: null,
        type: 'line.stopped',
        payload: { reason: 'Martin stopped the line' },
      } as PublicEvent;
      expect(gates([...held().events, stop], at(4))).toMatchObject({ status: 'blocked', beacon: undefined });
    });
  });

  it('lights no beacon on a station with nothing waiting on anyone', () => {
    const station = project(
      work('1').open().add(1, 'gates.started', 'actions', payloads.gatesStarted).events,
      at(2),
    ).stations.find((s) => s.stage === 'gates');
    expect(station).toMatchObject({ status: 'working', beacon: undefined });
  });

  it('is blocked everywhere under Stop the line', () => {
    const line: PublicEvent = {
      ...(work('1').open().events[0] as PublicEvent),
      work_item: null,
      type: 'line.stopped',
      payload: { reason: 'Martin stopped the line' },
    } as PublicEvent;
    const view = project([line], Date.now());
    expect(view.stations.every((s) => s.status === 'blocked')).toBe(true);
    expect(view.header).toMatchObject({ running: false, stopped: 'Martin stopped the line' });
  });

  it('says “sending back” while its return is drawn, unless it has failed or waits on a human', () => {
    for (const status of ['idle', 'working', 'passing', 'returning'] as const) {
      expect(whileSending(status, true)).toBe('returning');
    }
    expect(whileSending('failed', true)).toBe('failed');
    expect(whileSending('blocked', true)).toBe('blocked');
    expect(whileSending('working', false)).toBe('working');
  });

  it('stops saying “sending back” once the return is a few minutes old', () => {
    const events = work('1')
      .open()
      .add(1, 'gates.started', 'actions', payloads.gatesStarted)
      .add(3, 'gates.finished', 'actions', payloads.gatesFailed)
      .add(3.5, 'work.returned', 'factory', { from: 'gates', to: 'build', reason: 'A check failed' }).events;
    expect(gatesStatus(events, at(3.5) + RETURNING_MS + 1000)).toBe('idle');
    expect(project(events, at(4)).stations.find((s) => s.stage === 'build')?.status).toBe('working');
  });
});

describe('a station’s figure', () => {
  it('counts what is in the stage, and what left it today when nothing is', () => {
    const one = work('1').open().add(1, 'gates.started', 'actions', payloads.gatesStarted);
    expect(project(one.events, one.at(2)).stations.find((s) => s.stage === 'gates')?.figure).toBe('1 PR');
    one.add(3, 'gates.finished', 'actions', payloads.gatesPassed).add(4, 'review.submitted', 'reviewer', {
      pullRequest: 7,
      verdict: 'approved',
      note: 'Fine',
      findings: [],
    });
    expect(project(one.events, one.at(5)).stations.find((s) => s.stage === 'gates')?.figure).toBe('1 today');
  });

  it('gives a canary’s share of traffic at Release', () => {
    const one = work('1')
      .open()
      .add(1, 'release.started', 'rollouts', {
        version: 'v1.0.1',
        previous: 'v1.0.0',
        digest: `sha256:${'b'.repeat(64)}`,
        signed: true,
        admitted: true,
      })
      .add(2, 'canary.stepped', 'rollouts', {
        version: 'v1.0.1',
        weight: 25,
        analysis: {
          errorRate: { canary: 0, baseline: 0 },
          p99Ms: { canary: 100, baseline: 100 },
          journeys: { canary: [1, 1], baseline: [1, 1] },
        },
      });
    expect(project(one.events, one.at(3)).stations.find((s) => s.stage === 'release')?.figure).toBe('25%');
  });
});
