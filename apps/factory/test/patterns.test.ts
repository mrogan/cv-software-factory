import { describe, expect, it } from 'vitest';
import type { LogRecord } from '../src/clients/loki.ts';
import { describe as describeRecord, errorRecords, PatternMemory, reduce } from '../src/logs/patterns.ts';
import { ns } from './fakes.ts';

describe('reducing a message to a pattern', () => {
  it.each([
    ['numbers', 'timed out after 3000 ms', 'timed out after <n> ms'],
    ['decimals and versions', 'took 1.25 s on v2.0.1', 'took <n> s on <id>'],
    ['quoted values', `no such product 'glove-left' in "desk"`, 'no such product <value> in <value>'],
    ['backticked values', 'cannot read `price` of undefined', 'cannot read <value> of undefined'],
    ['UUIDs', 'order 3f2b8c1e-9d4a-4b7e-8a51-0c6d2e7f9a10 failed', 'order <id> failed'],
    ['hashes', 'build c02efd8f964de8e81d96b4e476577eddd5ced0db is stale', 'build <hash> is stale'],
    ['identifiers mixing letters and digits', 'row ord9x2f of table t42 is locked', 'row <id> of table <id> is locked'],
    ['dates and times', 'at 2026-10-03T20:42:56Z the queue stopped', 'at <time> the queue stopped'],
    ['addresses', 'connect ECONNREFUSED 10.42.0.7:5432', 'connect ECONNREFUSED <n>'],
    ['repeated spaces', 'failed   to  parse', 'failed to parse'],
    ['words that merely look like hex', 'the cache was effaced', 'the cache was effaced'],
    ['nothing to take out', 'URIError: URI malformed', 'URIError: URI malformed'],
  ])('takes out %s', (_what, message, pattern) => {
    expect(reduce(message)).toBe(pattern);
  });

  it('gives two errors that differ in what changes the same pattern', () => {
    expect(reduce(`user 'ann' hit item 17 at 12:01`)).toBe(reduce(`user 'bob' hit item 9 at 13:45`));
  });

  it('keeps apart errors that say different things', () => {
    expect(reduce('Invalid time value')).not.toBe(reduce('URI malformed'));
  });
});

const record = (time: string, line: string, fields: Record<string, string> = {}): LogRecord => ({
  ns: ns(time),
  time: new Date(time),
  line,
  fields,
});

describe('what an error record says went wrong', () => {
  it('is the exception it attaches, when it has one, so that a generic line does not hide it', () => {
    const a = record('2026-10-03T10:00:00Z', 'GET /products/a failed', {
      exception_type: 'RangeError',
      exception_message: 'Invalid time value',
    });
    const b = record('2026-10-03T10:01:00Z', 'GET /products/b failed', {
      exception_type: 'URIError',
      exception_message: 'URI malformed',
    });
    expect(describeRecord(a)).toBe('RangeError: Invalid time value');
    expect(describeRecord(b)).toBe('URIError: URI malformed');
  });

  it('is the line, with the path of the request replaced by its route, otherwise', () => {
    const a = record('2026-10-03T10:00:00Z', 'GET /products/duster-feather failed', {
      path: '/products/duster-feather',
      route: '/products/:slug',
    });
    const b = record('2026-10-03T10:00:00Z', 'GET /products/doorstop failed', {
      path: '/products/doorstop',
      route: '/products/:slug',
    });
    expect(errorRecords([a])[0]?.pattern).toBe(errorRecords([b])[0]?.pattern);
  });

  it('belongs to the route that raised it: the same error elsewhere is another finding', () => {
    const fields = { exception_type: 'URIError', exception_message: 'URI malformed' };
    const onSearch = errorRecords([record('2026-10-03T10:00:00Z', 'failed', { ...fields, route: '/search' })]);
    const onBasket = errorRecords([record('2026-10-03T10:00:00Z', 'failed', { ...fields, route: '/basket' })]);
    const noRoute = errorRecords([record('2026-10-03T10:00:00Z', 'failed', fields)]);
    expect(new Set([onSearch[0]?.pattern, onBasket[0]?.pattern, noRoute[0]?.pattern]).size).toBe(3);
    expect(noRoute[0]?.pattern.startsWith('* ')).toBe(true);
  });
});

describe('new patterns over a day', () => {
  const at = (time: string, line: string) => errorRecords([record(time, line)])[0];
  const batch = (...entries: [string, string][]) => entries.flatMap(([time, line]) => at(time, line) ?? []);

  it('says a pattern is new the first time, with every record of it in the batch', () => {
    const memory = new PatternMemory();
    const found = memory.fresh(
      batch(
        ['2026-10-03T10:00:00Z', 'disk full on volume 3'],
        ['2026-10-03T10:00:30Z', 'queue stalled'],
        ['2026-10-03T10:01:00Z', 'disk full on volume 7'],
      ),
    );
    expect(found.map((f) => f.pattern)).toEqual(['* disk full on volume <n>', '* queue stalled']);
    expect(found[0]?.records).toHaveLength(2);
  });

  it('does not say it again once the batch is dealt with', () => {
    const memory = new PatternMemory();
    const first = batch(['2026-10-03T10:00:00Z', 'disk full on volume 3']);
    expect(memory.fresh(first)).toHaveLength(1);
    // Until it is remembered, a failed send is tried again.
    expect(memory.fresh(first)).toHaveLength(1);
    memory.remember(first);
    expect(memory.fresh(batch(['2026-10-03T10:30:00Z', 'disk full on volume 9']))).toEqual([]);
  });

  it('says a pattern is new again when the log has not shown it for a day', () => {
    const memory = new PatternMemory();
    memory.remember(batch(['2026-10-03T10:00:00Z', 'queue stalled']));
    expect(memory.fresh(batch(['2026-10-04T09:59:00Z', 'queue stalled']))).toEqual([]);
    expect(memory.fresh(batch(['2026-10-04T10:01:00Z', 'queue stalled']))).toHaveLength(1);
  });

  it('counts a pattern seen every few hours as seen, however long ago it first appeared', () => {
    const memory = new PatternMemory();
    for (const time of ['2026-10-01T10:00:00Z', '2026-10-02T06:00:00Z', '2026-10-03T02:00:00Z']) {
      const records = batch([time, 'queue stalled']);
      memory.remember(records);
    }
    expect(memory.fresh(batch(['2026-10-03T20:00:00Z', 'queue stalled']))).toEqual([]);
  });
});
