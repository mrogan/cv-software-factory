import { createServer } from 'node:http';
import { listenLocal } from '@software-factory/testing';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { errSerializer, logOptions } from '../src/log.ts';

/** An error as a log line keeps it. */
function logged(error: unknown) {
  const lines: Record<string, unknown>[] = [];
  const log = pino(logOptions('info'), { write: (line: string) => lines.push(JSON.parse(line)) });
  log.error({ err: error }, 'failed');
  return lines[0]?.err as Record<string, unknown>;
}

describe('an error in the log', () => {
  it('says why fetch failed: a refused connection is not a name that did not resolve', async () => {
    const server = createServer();
    const { port } = await listenLocal(server);
    await new Promise((resolve) => server.close(resolve));

    const error = await fetch(`http://127.0.0.1:${port}/`).catch((e: unknown) => e);
    const err = logged(error);
    expect(err.type).toBe('TypeError');
    expect(err.message).toBe(`fetch failed: connect ECONNREFUSED 127.0.0.1:${port}`);
    expect(err.stack).toMatch(/^TypeError: fetch failed[\s\S]*\ncaused by: Error: connect ECONNREFUSED/);
  });

  it('says what each address answered when the cause says nothing itself', () => {
    const tried = Object.assign(
      new AggregateError([
        new Error('connect ECONNREFUSED ::1:4318'),
        new Error('connect ECONNREFUSED 127.0.0.1:4318'),
      ]),
      { code: 'ECONNREFUSED' },
    );
    expect(logged(new TypeError('fetch failed', { cause: tried })).message).toBe(
      'fetch failed: connect ECONNREFUSED ::1:4318; connect ECONNREFUSED 127.0.0.1:4318',
    );
    expect(
      logged(new TypeError('fetch failed', { cause: Object.assign(new AggregateError([]), { code: 'ETIMEDOUT' }) }))
        .message,
    ).toBe('fetch failed: ETIMEDOUT');
  });

  it('names an error by its name, or by its class where its name is only Error', () => {
    class Unnamed extends Error {}
    expect(logged(new DOMException('The operation was aborted due to timeout', 'TimeoutError')).type).toBe(
      'TimeoutError',
    );
    expect(logged(new Unnamed('no')).type).toBe('Unnamed');
    expect(logged(new Error('no')).type).toBe('Error');
  });

  it('keeps codes and kinds, and none of the other fields a library puts on its errors', () => {
    // As postgres.js makes them: the row a constraint refused, quoted in `detail`.
    const refused = Object.assign(new Error('new row for relation "events" violates check constraint "events_check"'), {
      name: 'PostgresError',
      code: '23514',
      detail: 'Failing row contains (a visitor’s words).',
      where: 'SQL statement',
    });
    const err = logged(refused);
    expect(err).toEqual({ type: 'PostgresError', message: refused.message, stack: refused.stack, code: '23514' });
    expect(JSON.stringify(err)).not.toContain('visitor');

    const github = Object.assign(new Error('Not Found'), { kind: 'not-found', status: 404, body: '{"secret":1}' });
    expect(logged(github)).toMatchObject({ kind: 'not-found', status: 404 });
    expect(logged(github)).not.toHaveProperty('body');
  });

  it('keeps a code only as text: a DOMException’s number says less than its name', () => {
    expect(logged(new DOMException('aborted', 'TimeoutError'))).not.toHaveProperty('code');
  });

  it('follows causes a few deep, and each once', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Object.assign(a, { cause: b });
    expect(logged(b).message).toBe('b: a');

    let deep = new Error('0');
    for (let i = 1; i <= 10; i++) deep = new Error(String(i), { cause: deep });
    expect(logged(deep).message).toBe('10: 9: 8: 7: 6: 5');
  });

  it('leaves what is not an error as it is', () => {
    expect(errSerializer('fetch failed')).toBe('fetch failed');
    expect(errSerializer(undefined)).toBeUndefined();
    expect(logged(42)).toBe(42);
  });
});
