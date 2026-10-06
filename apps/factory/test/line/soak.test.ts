import { VERSIONS } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import {
  type LineRow,
  problemOf,
  type SoakFacts,
  type StoredEvent,
  soakReport,
  soakText,
  stageMinutes,
} from '../../src/line/soak.ts';

const at = (time: string) => `2026-10-06T${time}:00.000Z`;
const COMMIT = 'c'.repeat(40);
let seq = 0;

const event = (time: string, type: keyof typeof VERSIONS, payload: unknown): StoredEvent => ({
  seq: ++seq,
  ts: at(time),
  type,
  version: VERSIONS[type],
  payload,
});

/** A work item a dry-run soak takes round: planned, built, through the gates, held at review, and merged. */
const round = (start: string) => [
  event(start, 'ticket.opened', { title: 'Server errors on /search', severity: 'broken' }),
  event('22:20', 'spec.written', { outcome: 'Search answers.', criteria: [], scope: ['src/'] }),
  event('22:50', 'pull-request.pushed', { number: 1_000_000_001, branch: 'factory/1-search', attempt: 1 }),
  event('22:51', 'gates.started', { pullRequest: 1_000_000_001, commit: COMMIT, checks: ['Unit tests'] }),
  event('22:53', 'gates.finished', {
    pullRequest: 1_000_000_001,
    commit: COMMIT,
    conclusion: 'passed',
    passed: 1,
    failed: [],
  }),
  event('23:00', 'hold.started', { stage: 'review', kind: 'held', cause: 'failures', reason: 'The reviewer failed' }),
  event('23:10', 'pull-request.merged', { number: 1_000_000_001, commit: 'd'.repeat(40), by: 'factory' }),
];

const row = (workItem: string, taken: string, more: Partial<LineRow> = {}): LineRow => ({
  workItem,
  stage: 'ended',
  takenAt: new Date(at(taken)),
  heldBy: null,
  heldUntil: null,
  ...more,
});

describe('a work item’s minutes in each stage', () => {
  it('counts from when the line took it, in the stage the line’s own decision had it in, until it ended', () => {
    expect(stageMinutes(round('21:00'), Date.parse(at('22:00')), Date.parse(at('23:59')))).toEqual({
      plan: 20,
      build: 30,
      gates: 3,
      review: 7,
      held: 10,
    });
  });

  it('counts a work item still on the line until now', () => {
    const waiting = round('21:00').slice(0, 4);
    expect(stageMinutes(waiting, Date.parse(at('22:00')), Date.parse(at('23:00')))).toEqual({
      plan: 20,
      build: 30,
      gates: 10,
    });
  });
});

describe('an event’s validity', () => {
  it('is its payload against its type’s current schema, once upcast', () => {
    expect(problemOf({ type: 'line.stopped', version: 1, payload: { reason: 'Martin stopped the line' } })).toBeNull();
    expect(problemOf({ type: 'line.stopped', version: 1, payload: {} })).toMatch(/^reason: /);
    expect(problemOf({ type: 'spend.cleared', version: 1, payload: { cap: 'day' } })).toBeNull();
    expect(problemOf({ type: 'moon.landed', version: 1, payload: {} })).toBe('a type this factory does not know');
    expect(problemOf({ type: 'line.stopped', version: 99, payload: {} })).toBe('a newer version');
  });
});

describe('the morning’s report', () => {
  const facts = (more: Partial<SoakFacts> = {}): SoakFacts => ({
    now: new Date(at('23:59')),
    since: new Date(at('21:30')),
    line: [row('1', '22:00'), row('2', '22:00', { stage: 'plan' }), row('0', '20:00')],
    events: new Map([
      ['1', round('21:00')],
      ['2', round('21:00').slice(0, 1)],
    ]),
    checked: 120,
    invalid: [],
    runners: [{ kind: 'volume', name: 'work-2', workItem: '2' }],
    spend: [{ provider: 'local', calls: 41, usd: 0 }],
    ...more,
  });

  it('is all clear for a night that left nothing behind and spent nothing', () => {
    const report = soakReport(facts());
    expect(report.ok).toBe(true);
    expect(report.workItems).toMatchObject({ taken: 2, byEnd: { merged: 1, plan: 1 } });
    expect(report.workItems.stages.plan).toEqual({ items: 2, medianMinutes: (20 + 119) / 2, maxMinutes: 119 });
    expect(report.spend).toMatchObject({ usd: 0, calls: 41 });
    expect(soakText(report).split('\n')[0]).toContain('all clear');
  });

  it('names a lease held past its expiry, a runner left for an ended work item, an event not valid, and any spend', () => {
    const report = soakReport(
      facts({
        line: [
          row('1', '22:00'),
          row('2', '22:00', { stage: 'build', heldBy: 'line-a', heldUntil: new Date(at('23:00')) }),
        ],
        runners: [
          { kind: 'job', name: 'reviewer-1-1-3-agent', workItem: '1' },
          { kind: 'volume', name: 'work-1', workItem: '1' },
          { kind: 'volume', name: 'work-2', workItem: '2' },
        ],
        invalid: [{ seq: 7, type: 'line.stopped', version: 1, problem: 'reason: Required' }],
        spend: [{ provider: 'anthropic', calls: 2, usd: 0.04 }],
      }),
    );
    expect(report.ok).toBe(false);
    expect(report.leases.stuck).toEqual([
      { workItem: '2', stage: 'build', heldBy: 'line-a', heldUntil: '2026-10-06T23:00:00.000Z' },
    ]);
    expect(report.runners.left.map((r) => r.name)).toEqual(['reviewer-1-1-3-agent', 'work-1']);
    expect(report.events).toMatchObject({ checked: 120, invalid: 1 });
    const text = soakText(report);
    expect(text).toContain('NO  leases: 1 held past expiry (#2 by line-a)');
    expect(text).toContain('left for ended work items: job reviewer-1-1-3-agent, volume work-1');
    expect(text).toContain('#7 line.stopped v1: reason: Required');
    expect(text).toContain('NO  spend: $0.0400 over 2 calls');
  });

  it('is not clear when it could not read the cluster', () => {
    const report = soakReport(facts({ runners: { error: 'No service account here' } }));
    expect(report.ok).toBe(false);
    expect(soakText(report)).toContain('NO  runners: not read (No service account here)');
  });
});
