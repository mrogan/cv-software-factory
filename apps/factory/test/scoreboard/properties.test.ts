/**
 * Properties of the scoreboard, over keys and event logs fast-check makes up, every one invented: the answer key's
 * file, which is refused without a word of what it holds, and the figures, which keep the promises `figures.ts` makes
 * of them however the events fall. `figures.test.ts` holds the examples.
 *
 * A failure prints the seed and the shrunk case that broke the property: `fc.assert(..., { seed, path })` replays it.
 */
import { SYMPTOM_CLASSES } from '@software-factory/events';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Fingerprint, KeyEntry } from '../../../../policy/scoreboard.ts';
import { figures, lastBoundary, median, type ScoreEvent, tickets } from '../../src/scoreboard/figures.ts';
import { parseKey } from '../../src/scoreboard/key.ts';

describe('the key', () => {
  /**
   * Every string a made-up key holds carries this mark, but its symptom classes, which are the events' own words, and
   * no message of the key's has it: a refusal with the mark in it has quoted the key.
   */
  const MARK = 'ж';
  const secret = fc.string({ maxLength: 20 }).map((s) => `${MARK}${s}`);
  const path = fc
    .array(fc.webSegment(), { maxLength: 4 })
    .map((segments) => `/${MARK}${segments.join('/')}`.slice(0, 200));
  // Any code points, so that a passage's case is tried beyond ASCII; each takes at most two of the 200 a passage may.
  const passage = fc.string({ unit: 'binary', maxLength: 90 }).map((s) => `${MARK}${s}`);
  const fingerprint: fc.Arbitrary<Fingerprint> = fc.oneof(
    fc.record({ route: fc.oneof(path, fc.constant('*')), class: fc.constantFrom(...SYMPTOM_CLASSES) }),
    fc.record({ page: path, text: passage }),
  );

  /** What makes two entries' fingerprints the same, as the key counts them: a passage's case does not count. */
  const sameness = (f: Fingerprint) =>
    'route' in f ? `route ${f.route} ${f.class}` : `page ${f.page} ${f.text.trim().toLowerCase()}`;

  /** A key the scoreboard must take: each id and each fingerprint once. */
  const validKey = fc
    .uniqueArray(fingerprint, { maxLength: 8, selector: sameness })
    .chain((fingerprints) =>
      fc
        .uniqueArray(secret, { minLength: fingerprints.length, maxLength: fingerprints.length })
        .map((ids) => fingerprints.map((f, i): KeyEntry => ({ id: ids[i] as string, fingerprint: f }))),
    );

  /** One way an entry can be wrong, each carrying a secret where a careless message would quote it. */
  const spoil = fc.oneof(
    secret.map((s) => (e: KeyEntry) => ({ ...e, [s]: s })), // a field the key does not have
    secret.map((s) => (e: KeyEntry) => ({ ...e, fingerprint: { route: '/', class: s } })), // a class nobody knows
    secret.map((s) => (e: KeyEntry) => ({ ...e, fingerprint: { page: s, text: s } })), // a page that is no path
    secret.map((s) => (e: KeyEntry) => ({ ...e, fingerprint: { page: '/', text: s.repeat(201) } })), // too long
    secret.map((s) => (e: KeyEntry) => ({ ...e, fingerprint: { route: '/', class: 'server-error', text: s } })),
    fc.constant((e: KeyEntry) => ({ ...e, id: '' })),
    fc.constant((e: KeyEntry) => ({ id: e.id })),
    fc.constant((e: KeyEntry) => [e.id, e.fingerprint]),
  );

  /** A valid key's text, made wrong: an entry spoilt, an entry or its fingerprint twice, or the text cut short. */
  const invalidText = fc.oneof(
    fc
      .tuple(
        validKey.filter((key) => key.length > 0),
        spoil,
        fc.nat(),
      )
      .map(([key, spoilt, n]) => JSON.stringify(key.map((e, i) => (i === n % key.length ? spoilt(e) : e)))),
    fc
      .tuple(
        validKey.filter((key) => key.length > 0),
        fc.nat(),
        secret,
        fc.boolean(),
      )
      .map(([key, n, id, sameId]) => {
        const twice = key[n % key.length] as KeyEntry;
        return JSON.stringify([
          ...key,
          sameId ? { ...twice, fingerprint: { route: '/', class: SYMPTOM_CLASSES[0] } } : { ...twice, id },
        ]);
      }),
    fc
      .tuple(
        validKey.filter((key) => key.length > 0),
        fc.nat(),
      )
      .map(([key, n]) => {
        const text = JSON.stringify(key);
        return text.slice(0, 1 + (n % (text.length - 1)));
      }),
  );

  it('takes any key with each id and fingerprint once, as written, its passages trimmed', () => {
    fc.assert(
      fc.property(validKey, (key) => {
        const trimmed = key.map((e) =>
          'text' in e.fingerprint ? { ...e, fingerprint: { ...e.fingerprint, text: e.fingerprint.text.trim() } } : e,
        );
        expect(parseKey(JSON.stringify(key))).toEqual(trimmed);
      }),
    );
  });

  it('refuses a key that is not valid, saying where and never a word of what it holds', () => {
    fc.assert(
      fc.property(invalidText, (text) => {
        let message = '';
        try {
          parseKey(text);
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toMatch(/^The answer key is not (JSON|valid: .+)\.$/);
        expect(message).not.toContain(MARK);
      }),
    );
  });
});

describe('the figures', () => {
  const T0 = Date.parse('2026-10-11T00:00:00Z');
  /** Past the last event a log can have. */
  const END = T0 + 30 * 90 * 60_000;

  /** Few routes, classes and passages, so that tickets and entries meet. */
  const fingerprint = fc.oneof(
    fc.record({ route: fc.constantFrom('/a', '/b', '*'), class: fc.constantFrom('server-error', 'missing-alt') }),
    fc.record({
      page: fc.constantFrom('/p', '/q'),
      text: fc.constantFrom('moon is cheese', 'The Moon is CHEESE, they say', 'cheese'),
    }),
  ) as fc.Arbitrary<Fingerprint>;
  const key = fc
    .array(fingerprint, { maxLength: 6 })
    .map((fs) => fs.map((f, i): KeyEntry => ({ id: `${i}`, fingerprint: f })));

  /** What happens to a work item after its ticket opens, in any order the line could put it. */
  const after = fc.oneof(
    fc.constant({ type: 'signal.received' as const }),
    {
      weight: 2,
      arbitrary: fc
        .constantFrom('verified', 'verified', 'no-change')
        .map((outcome) => ({ type: 'work-item.closed' as const, payload: { outcome } })),
    },
    fc.constant({ type: 'work-item.reopened' as const }),
    fc.boolean().map((dryRun) => ({ type: 'verification.finished' as const, payload: { dryRun } })),
    fc
      .constantFrom('cleared', 'persists')
      .map((outcome) => ({ type: 'signal.rechecked' as const, payload: { outcome } })),
  );

  /**
   * The store's events, in its order, each up to an hour and a half after the last, so that a work item's life often
   * falls inside one of the cadence's windows: a few work items, interleaved, each opening its one ticket with its
   * first event that is not a signal, and the rest of its life after.
   */
  const log = fc
    .array(fc.tuple(fc.integer({ min: 1, max: 3 }), fingerprint, after, fc.integer({ min: 1, max: 90 })), {
      maxLength: 30,
    })
    .map((steps) => {
      const opened = new Set<number>();
      let minutes = 0;
      return steps.map(([item, opening, step, gap]): ScoreEvent => {
        minutes += gap;
        const base = { ts: new Date(T0 + minutes * 60_000).toISOString(), work_item: `${item}` };
        if (opened.has(item) || step.type === 'signal.received') return { ...base, ...step } as ScoreEvent;
        opened.add(item);
        return { ...base, type: 'ticket.opened', payload: { fingerprint: opening } } as ScoreEvent;
      });
    });

  /** The figures as the scoreboard publishes them once `events` are all in: found as of the cadence's last boundary. */
  const published = (events: readonly ScoreEvent[], entries: readonly KeyEntry[]) =>
    figures(tickets(events), entries, lastBoundary(Date.parse(events.at(-1)?.ts ?? new Date(T0).toISOString())));

  it('never count more verified than found, nor more found than there are entries', () => {
    fc.assert(
      fc.property(log, key, (events, entries) => {
        const { entries: count, found, verified, medianMs, falsePositives } = published(events, entries);
        expect(count).toBe(entries.length);
        expect(verified).toBeLessThanOrEqual(found);
        expect(found).toBeLessThanOrEqual(count);
        expect(falsePositives).toBeLessThanOrEqual(tickets(events).length);
        expect(medianMs === null).toBe(verified === 0);
        if (medianMs !== null) expect(medianMs).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it('never take an entry back from found as events come in or time passes, though a reopening takes it from verified', () => {
    // Often before every ticket, where only verifications count.
    const boundary = fc.oneof(fc.constant(T0), fc.integer({ min: T0, max: END }));
    fc.assert(
      fc.property(log, key, boundary, boundary, (events, entries, a, b) => {
        const [then, now] = [Math.min(a, b), Math.max(a, b)];
        // Found after each event in turn, as of the earlier boundary, and then all of them as of the later.
        const found = events.map((_, i) => figures(tickets(events.slice(0, i + 1)), entries, then).found);
        found.push(figures(tickets(events), entries, now).found);
        found.reduce((before, count) => {
          expect(count).toBeGreaterThanOrEqual(before);
          return count;
        }, 0);
      }),
    );
  });

  it('do not depend on the order the tickets are counted in', () => {
    fc.assert(
      fc.property(log, key, fc.integer({ min: T0, max: END }), (events, entries, foundBefore) => {
        const all = tickets(events);
        const reversed = [...all].reverse();
        expect(figures(reversed, entries, foundBefore)).toEqual(figures(all, entries, foundBefore));
      }),
    );
  });

  it('take a median within the times it is of, whatever their order', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 30 * 86_400_000 }), { minLength: 1 }), (times) => {
        const middle = median(times);
        expect(middle).toBeGreaterThanOrEqual(Math.min(...times));
        expect(middle).toBeLessThanOrEqual(Math.max(...times));
        expect(median([...times].reverse())).toBe(middle);
        expect(times.filter((t) => t < (middle ?? 0)).length).toBeLessThanOrEqual(times.length / 2);
        expect(times.filter((t) => t > (middle ?? 0)).length).toBeLessThanOrEqual(times.length / 2);
      }),
    );
  });

  it('move found only on the cadence’s boundaries, which fall on the same hours every day', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: Date.parse('2100-01-01T00:00:00Z') }),
        fc.constantFrom(1, 2, 3, 4, 6, 8, 12, 24),
        (now, hours) => {
          const boundary = lastBoundary(now, hours);
          expect(boundary).toBeLessThanOrEqual(now);
          expect(now - boundary).toBeLessThan(hours * 3_600_000);
          expect(new Date(boundary).getUTCHours() % hours).toBe(0);
          expect([
            new Date(boundary).getUTCMinutes(),
            new Date(boundary).getUTCSeconds(),
            new Date(boundary).getUTCMilliseconds(),
          ]).toEqual([0, 0, 0]);
        },
      ),
    );
  });
});
