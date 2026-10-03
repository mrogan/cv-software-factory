import { JudgeWaiting } from '@software-factory/triage';
import { describe, expect, it } from 'vitest';
import {
  BadRequest,
  CassetteMissing,
  GatewayUnavailable,
  ProviderError,
  SpendCapped,
} from '../../src/gateway/errors.ts';
import { waitingFor } from '../../src/gateway/waiting.ts';

const NOW = new Date('2026-10-04T09:00:00Z');

describe('what a report waits out', () => {
  it.each([
    ['the gateway restarting', new GatewayUnavailable('The gateway could not be reached.'), 60_000],
    ['a rate limit', new ProviderError('rate-limited', 'TypeSafe answered with status 429.', 429), 60_000],
    ['an overload', new ProviderError('overloaded', 'TypeSafe answered with status 529.', 529), 60_000],
    ['a timeout', new ProviderError('timeout', 'TypeSafe did not answer.'), 60_000],
    ['no cassette and no key', new CassetteMissing('a'.repeat(64)), 600_000],
  ])('waits out %s without using an attempt', (_, error, ms) => {
    const waiting = waitingFor(error, NOW);
    expect(waiting).toBeInstanceOf(JudgeWaiting);
    expect(waiting?.until.getTime()).toBe(NOW.getTime() + ms);
  });

  it('waits for a spend cap until it resets', () => {
    const capped = new SpendCapped('day', 20, 20.01, '2026-10-05T00:00:00.000Z');
    expect(waitingFor(capped, NOW)?.until.toISOString()).toBe('2026-10-05T00:00:00.000Z');
  });

  it('counts a rejected or malformed answer, a bad request and anything else as a real failure', () => {
    expect(waitingFor(new ProviderError('rejected', 'TypeSafe answered with status 422.', 422), NOW)).toBeUndefined();
    expect(waitingFor(new ProviderError('malformed', 'TypeSafe answered with something else.'), NOW)).toBeUndefined();
    expect(waitingFor(new BadRequest('The request is not valid.'), NOW)).toBeUndefined();
    expect(waitingFor(new Error('anything'), NOW)).toBeUndefined();
  });
});
