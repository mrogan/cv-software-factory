import { STAGES } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { project, projectSheet, upTo } from '../../web/src/projection/index.ts';
import { END, SAMPLES } from './support.ts';

const view = project(SAMPLES, END);
const card = (number: string) => view.cards.find((c) => c.number === number);

describe('the samples, projected', () => {
  it('show every outcome', () => {
    expect(new Set(view.cards.map((c) => c.outcome))).toEqual(
      new Set(['verified', 'rolled-back', 'held', 'closed', 'no-ticket', 'needs-you', 'in-progress']),
    );
  });

  it('show every picture in the design system’s table', () => {
    expect(new Set(view.cards.map((c) => c.picture.type))).toEqual(
      new Set(['wipe', 'metric', 'logs', 'package', 'scan', 'rollback', 'refusal', 'judgement', 'spec']),
    );
  });

  it('put every station in every state at some point, and send work back', () => {
    const seen = new Set<string>();
    for (const event of SAMPLES) {
      const at = Date.parse(event.ts);
      for (const t of [at, at + 60_000]) for (const s of project(SAMPLES, t).stations) seen.add(s.status);
    }
    expect(seen).toEqual(new Set(['idle', 'working', 'returning', 'passing', 'blocked', 'failed']));
  });

  it('end with the line working: a release on its canary', () => {
    expect(view.header).toMatchObject({ running: true, autonomy: 'guarded' });
    expect(view.stations.find((s) => s.stage === 'release')).toMatchObject({ status: 'working', figure: '25%' });
    expect(card('1302')).toMatchObject({
      outcome: 'in-progress',
      versions: { from: 'v0.9.6', to: 'v0.9.7', onCanary: true },
    });
  });

  it('keep what waits on Martin in the reel', () => {
    expect(card('1300')?.outcome).toBe('needs-you');
    expect(card('1274')?.outcome).toBe('held');
    expect(view.stations.find((s) => s.stage === 'plan')).toMatchObject({ status: 'blocked', figure: '1 waiting' });
    expect(view.stations.find((s) => s.stage === 'gates')).toMatchObject({ status: 'blocked', figure: '1 held' });
  });

  it('say how far each item got, and where it stopped', () => {
    expect(card('1271')?.segments).toEqual(['skipped', 'skipped', ...Array(6).fill('passed')]);
    expect(card('1276')?.segments).toEqual([
      'skipped',
      'skipped',
      'skipped',
      'skipped',
      'passed',
      'passed',
      'stopped',
      'none',
    ]);
    expect(card('1274')?.segments).toEqual([
      'skipped',
      'skipped',
      'skipped',
      'passed',
      'stopped',
      'none',
      'none',
      'none',
    ]);
    expect(card('1268')?.segments).toEqual(['passed', 'closed', ...Array(6).fill('none')]);
    expect(card('1300')?.segments).toEqual(['skipped', 'skipped', 'waiting', ...Array(5).fill('none')]);
    expect(card('1302')?.segments).toEqual([...Array(6).fill('passed'), 'now', 'none']);
  });

  it('strike through a version that was rolled back, on the timeline', () => {
    expect(view.timeline.versions).toContainEqual({ index: 5, version: 'v0.9.1', rolledBack: true });
    expect(view.timeline.days).toHaveLength(5);
  });

  it('say which work a visitor started, and nothing about the visitor', () => {
    const cards = project(SAMPLES, END).cards;
    expect(cards.filter((c) => c.byVisitor).map((c) => c.number)).toEqual(['1268', '1274', '1293', '1296', '1302']);
    expect(SAMPLES.some((e) => e.type === 'work-item.opened' && 'visitor' in e.payload)).toBe(false);
  });

  it('label every card a sample', () => {
    expect(view.sample).toBe(true);
    expect(view.cards.every((c) => c.sample)).toBe(true);
  });
});

describe('a sheet', () => {
  it('steps through the item’s story, ending at now while it is still on the line', () => {
    const sheet = projectSheet(SAMPLES, '1302', END);
    expect(sheet?.chapters.map((c) => c.label)).toEqual([
      'INJECT',
      'ON SITE',
      'SIGNAL',
      'TICKET',
      'SPEC',
      'PR',
      'GATES',
      'SENT BACK',
      'TRY 2',
      'GATES',
      'REVIEW',
      'CANARY',
      'NOW',
    ]);
    const positions = sheet?.chapters.map((c) => c.position) ?? [];
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions[0]).toBe(0);
    expect(positions.at(-1)).toBe(100);
  });

  it('shows the site as it stood at each step', () => {
    const sheet = projectSheet(SAMPLES, '1296', END);
    const site = (label: string) => sheet?.chapters.find((c) => c.label === label)?.site?.side;
    expect(site('INJECT')).toBeUndefined();
    expect(site('ON SITE')).toBe('before');
    expect(site('SIGNAL')).toBe('broken');
    expect(site('VERIFIED')).toBe('fixed');
  });

  it('draws a verification that found the problem still there as reopened, in the warm colour', () => {
    const chapter = (events: typeof SAMPLES, label: string) =>
      projectSheet(events, '1296', END)?.chapters.find((c) => c.label === label);
    expect(chapter(SAMPLES, 'VERIFIED')?.tone).toBe('ok');
    const persisted = SAMPLES.map((event) =>
      event.work_item === '1296' && event.type === 'verification.finished'
        ? { ...event, payload: { ...event.payload, outcome: 'persists' as const } }
        : event,
    );
    expect(chapter(persisted, 'REOPENED')?.tone).toBe('attn');
  });

  it('totals each agent’s calls, tokens and cost', () => {
    const sheet = projectSheet(SAMPLES, '1296', END);
    expect(sheet?.agents.map((a) => a.agent)).toEqual(['planner', 'coder', 'reviewer']);
    const total = sheet?.agents.reduce((sum, a) => sum + a.cost, 0) ?? 0;
    expect(total).toBeCloseTo(sheet?.card.spend ?? 0, 6);
    expect(sheet?.facts).toEqual({
      foundBy: 'Probe · home journey',
      humanLines: 0,
      ticket: { category: 'functional', severity: 'broken', fingerprint: '/ · wrong-result' },
    });
  });

  it('lists the gates of the latest attempt', () => {
    const gates = projectSheet(SAMPLES, '1302', END)?.gates ?? [];
    expect(gates).toHaveLength(12);
    expect(gates.every((g) => g.conclusion === 'success')).toBe(true);
  });

  it('withholds a visitor’s report, saying where it came from', () => {
    expect(projectSheet(SAMPLES, '1268', END)?.report).toEqual({ page: '/contact', quarantined: false });
  });

  it('compares every page with the version before', () => {
    const pages = projectSheet(SAMPLES, '1271', END)?.pages;
    expect(pages?.against).toBe('v0.8.5');
    expect(pages?.list.find((p) => p.page === 'Products')).toMatchObject({ intended: true });
    expect(pages?.list.find((p) => p.page === 'Contact')).toMatchObject({ changed: 0, intended: false });
  });
});

describe('replay', () => {
  // A seeded sequence, so a failure can be reproduced.
  function* times(count: number) {
    let state = 1_296;
    const first = Date.parse(SAMPLES[0]?.ts ?? '');
    for (let i = 0; i < count; i++) {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      yield first + (state / 2_147_483_648) * (END - first + 3_600_000);
    }
  }
  const instants = [...SAMPLES.map((event) => Date.parse(event.ts)), ...times(40)];

  it('draws the same view at t from every event as from only the events up to t', () => {
    for (const t of instants) expect(project(SAMPLES, t)).toEqual(project(upTo(SAMPLES, t), t));
  });

  it('draws the same sheet at t, the same way', () => {
    for (const t of instants.filter((_, i) => i % 7 === 0)) {
      for (const number of ['1271', '1296', '1302']) {
        expect(projectSheet(SAMPLES, number, t)).toEqual(projectSheet(upTo(SAMPLES, t), number, t));
      }
    }
  });

  it('shows nothing of a work item before it opened', () => {
    const before1302 = Date.parse('2026-10-03T09:11:00Z');
    expect(projectSheet(SAMPLES, '1302', before1302)).toBeUndefined();
    expect(project(SAMPLES, before1302).cards.map((c) => c.number)).not.toContain('1302');
    expect(STAGES).toHaveLength(8);
  });
});
