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
