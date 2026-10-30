import { validate } from '@software-factory/events/schemas';
import { describe, expect, it } from 'vitest';
import { environmentEvents, senseReopened } from '../src/events.ts';

describe('a problem held while what its sense reads was not healthy', () => {
  it('fits its events to the store, when everything the log watcher reads was unhealthy at once', () => {
    const saw = 'x'.repeat(160);
    const signal = {
      sense: 'logs' as const,
      check: 'every request leaves a record',
      route: '/products/:slug',
      version: 'v0.9.2',
      symptom: 'missing-log' as const,
      observedAt: '2026-10-13T19:47:57.000Z',
      artifacts: [],
      environment: {
        at: '2026-10-13T19:47:57.000Z',
        dependencies: (['prometheus', 'loki', 'tempo', 'disk'] as const).map((name) => ({ name, healthy: false, saw })),
      },
    };
    const events = environmentEvents(signal, 'signal-1', '1037', new Date(signal.observedAt));
    for (const event of events) expect(validate(event)).toEqual({ ok: true });
    expect(events.find((event) => event.type === 'hold.started')?.payload).toMatchObject({
      cause: 'environment',
      reason: expect.stringMatching(
        /^The log watcher found a new problem while Prometheus, Loki, Tempo and the cluster’s disk were not healthy: /,
      ),
    });
  });
});

describe('a ticket a sense saw again', () => {
  it('reopens with its reason cut between characters, and marked, when the check is long', () => {
    const signal = {
      sense: 'crawler' as const,
      check: '\u{1F600}'.repeat(40),
      route: `/products/${'a'.repeat(70)}`,
      version: 'a'.repeat(40),
      symptom: 'broken-link' as const,
      observedAt: '2026-10-13T19:47:57.000Z',
      artifacts: [],
    };
    const events = senseReopened(signal, 'signal-1', '1037', new Date(signal.observedAt));
    for (const event of events) expect(validate(event)).toEqual({ ok: true });
    const reason = events.find((event) => event.type === 'work-item.reopened')?.payload.reason as string;
    expect(reason.length).toBeLessThanOrEqual(200);
    expect(reason.endsWith('…')).toBe(true);
    expect(reason.isWellFormed()).toBe(true);
  });
});
