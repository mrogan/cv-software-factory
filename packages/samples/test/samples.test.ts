import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTS, KINDS, type PublicEvent } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { LOG } from '../src/captures.ts';
import { publicSamples } from '../src/export.ts';
import { sampleEvents } from '../src/index.ts';

const events = sampleEvents();
const published = publicSamples();
const of = <K extends PublicEvent['type']>(type: K) =>
  published.filter((event): event is PublicEvent<K> => event.type === type);

describe('the samples', () => {
  it('are all valid events, each work item opening before anything else happens to it', () => {
    const opened = new Set<string>();
    for (const event of events) {
      if (event.type === 'work-item.opened' && event.work_item) opened.add(event.work_item);
      else if (event.work_item) expect(opened.has(event.work_item), `${event.work_item} ${event.type}`).toBe(true);
    }
  });

  it('say they are samples', () => {
    expect(of('work-item.opened').every((event) => event.payload.sample)).toBe(true);
  });

  it('cover every kind of work item but a planner’s finding', () => {
    const kinds = KINDS.filter((kind) => kind !== 'planner-finding');
    expect(new Set(of('work-item.opened').map((event) => event.payload.kind))).toEqual(new Set(kinds));
  });

  it('have model calls from every agent, on Claude and on the local model, and a Jev judgement', () => {
    const agents = new Set([...of('model.called').map((event) => event.payload.agent), 'triage']);
    expect(agents).toEqual(new Set(AGENTS));
    expect(new Set(of('model.called').map((event) => event.payload.provider))).toEqual(new Set(['anthropic', 'local']));
    expect(of('judgement.made').length).toBeGreaterThan(0);
  });

  it('record one model call event for each agent’s step, as the line does', () => {
    expect(of('model.called').some((event) => event.payload.calls > 1)).toBe(true);
  });

  it('send work back upstream at least once', () => {
    expect(of('work.returned').length).toBeGreaterThan(0);
  });

  it('end with a work item still on the line', () => {
    const last = published.at(-1);
    const closed = new Set(of('work-item.closed').map((event) => event.work_item));
    expect(last?.work_item && !closed.has(last.work_item)).toBe(true);
  });

  it('measure every step a release records before it is promoted, and promote none early', () => {
    for (const start of of('release.started')) {
      const { release, steps } = start.payload;
      const later = published.filter(
        (event) =>
          event.work_item === start.work_item && 'release' in event.payload && event.payload.release === release,
      );
      const promotion = later.findIndex((event) => event.type === 'release.promoted');
      if (promotion < 0) continue;
      // Every step the release recorded, each measured before the promotion, and none after it.
      const weights = later.flatMap((event) => (event.type === 'canary.stepped' ? [event.payload.weight] : []));
      const before = later
        .slice(0, promotion)
        .flatMap((event) => (event.type === 'canary.stepped' ? [event.payload.weight] : []));
      expect(before, release).toEqual(steps?.map((step) => step.weight));
      expect(weights, release).toEqual(before);
    }
  });

  it('ship as milestone 6’s line does: a release on two work items, releases on none, and each way one ends', () => {
    const on = new Map<string, Set<string | null>>();
    for (const event of of('release.started')) {
      on.set(event.payload.release, (on.get(event.payload.release) ?? new Set()).add(event.work_item));
    }
    expect([...on.values()].some((items) => items.size > 1)).toBe(true);
    expect(of('release.started').some((event) => event.work_item === null)).toBe(true);
    expect(of('release.rolled-back').some((event) => event.payload.failed.every((m) => !m.series))).toBe(true);
    expect(of('signal.received').some((event) => event.payload.sense === 'canary')).toBe(true);
    expect(of('verification.finished').map((event) => event.payload.outcome)).toContain('persists');
    expect(of('work.returned').some((event) => event.payload.from === 'verify')).toBe(true);
    expect(of('work-item.reopened').length).toBeGreaterThan(0);
    expect(of('line.stopped').length).toBeGreaterThan(0);
  });

  it('mark a dry run’s release and its verification, and nothing else', () => {
    const dry = published.filter((event) => 'dryRun' in event.payload && event.payload.dryRun);
    expect(new Set(dry.map((event) => event.type))).toEqual(
      new Set(['release.started', 'canary.stepped', 'release.promoted', 'verification.finished']),
    );
    expect(new Set(dry.map((event) => event.work_item))).toEqual(new Set(['1310']));
  });

  it('end with a canary in flight, and a merge waiting for Martin’s deploy', () => {
    const last = of('release.started').at(-1);
    const ended = published.filter(
      (event) =>
        (event.type === 'release.promoted' || event.type === 'release.rolled-back') &&
        event.payload.release === last?.payload.release,
    );
    expect(ended).toEqual([]);
    const holds = of('hold.started').filter((event) => event.payload.cause === 'deploy');
    const waiting = holds.filter(
      (hold) =>
        !published.some((e) => e.type === 'release.started' && e.work_item === hold.work_item && e.seq > hold.seq),
    );
    expect(waiting.map((hold) => hold.work_item)).toEqual(['1321']);
  });

  it('keep the score from off to the figures the line’s own tickets earn', () => {
    const scores = of('score.updated').map((event) => event.payload);
    expect(scores[0]).toEqual({ keyed: false });
    const keyed = scores.flatMap((score) => (score.keyed ? [score] : []));
    // Verified moves both ways: a reopened ticket stops counting until it is verified again.
    expect(keyed.map((score) => score.verified)).toEqual([0, 1, 2, 3, 4, 4, 5, 6, 6, 5, 5]);
    expect(keyed.every((score, i) => i === 0 || score.found >= (keyed[i - 1]?.found ?? 0))).toBe(true);
  });

  it('publish nothing a visitor may not see: no keys, no report text', () => {
    const log = readFileSync(join(LOG, 'events.ndjson'), 'utf-8');
    for (const event of events) {
      if (event.type === 'work-item.opened' && event.payload.visitor) {
        expect(log).not.toContain(event.payload.visitor.key);
      }
      if (event.type === 'signal.received' && event.payload.report?.text) {
        expect(log).not.toContain(event.payload.report.text.slice(0, 30));
      }
    }
  });
});
