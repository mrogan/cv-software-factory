import { describe, expect, it } from 'vitest';
import { REPORTS } from '../../../policy/triage.ts';
import { type ReportAnswers, routeFinding, routeReport, severityOf } from '../src/routing.ts';
import { pathOf, privatePath, scrub, shortPath } from '../src/scrub.ts';

const problem: ReportAnswers = { category: 'functional', symptom: 'wrong-result', severity: 2.9, injection: 0.02 };
const just = (by: number) => Math.round(by * 1000) / 1000;

describe('routing a report', () => {
  it.each<[string, Partial<ReportAnswers>, ReturnType<typeof routeReport>['route']]>([
    ['a problem', {}, 'ticket'],
    ['instructions, at the threshold', { injection: REPORTS.quarantine }, 'quarantine'],
    ['instructions, just below it', { injection: just(REPORTS.quarantine - 0.001) }, 'ticket'],
    ['instructions in a suggestion', { category: 'suggestion', injection: 0.9 }, 'quarantine'],
    ['instructions in chatter', { category: 'not-a-defect', injection: 0.9 }, 'quarantine'],
    ['a suggestion', { category: 'suggestion' }, 'park'],
    ['chatter', { category: 'not-a-defect' }, 'discard'],
    ['a repeat, at the threshold', { repeat: { workItem: '1004', probability: REPORTS.repeat } }, 'repeat'],
    ['a repeat, just below it', { repeat: { workItem: '1004', probability: just(REPORTS.repeat - 0.001) } }, 'ticket'],
    ['none of the open tickets', { repeat: { workItem: null, probability: 0.97 } }, 'ticket'],
    ['a repeat of a suggestion', { category: 'suggestion', repeat: { workItem: '1004', probability: 0.9 } }, 'park'],
  ])('routes %s', (_, answers, route) => {
    expect(routeReport({ ...problem, ...answers }).route).toBe(route);
  });

  it('names the ticket a repeat joins, and gives a new ticket its category, symptom and severity', () => {
    expect(routeReport({ ...problem, repeat: { workItem: '1004', probability: 0.8 } })).toEqual({
      route: 'repeat',
      joined: '1004',
    });
    expect(routeReport(problem)).toEqual({
      route: 'ticket',
      category: 'functional',
      symptom: 'wrong-result',
      severity: 'broken',
    });
  });

  it.each([
    [0, 'cosmetic'],
    [REPORTS.severity.degraded - 0.01, 'cosmetic'],
    [REPORTS.severity.degraded, 'degraded'],
    [REPORTS.severity.broken - 0.01, 'degraded'],
    [REPORTS.severity.broken, 'broken'],
    [3, 'broken'],
  ])('reads severity %d as %s: a defect is never "no harm"', (expected, severity) => {
    expect(severityOf(expected)).toBe(severity);
  });
});

describe('routing a planner’s finding', () => {
  it('routes it as a report, but never to a ticket: a defect is parked with what Jev made of it', () => {
    expect(routeFinding(problem)).toEqual({
      route: 'park',
      defect: { category: 'functional', symptom: 'wrong-result', severity: 'broken' },
    });
    expect(routeFinding({ ...problem, category: 'suggestion' })).toEqual({ route: 'park' });
    expect(routeFinding({ ...problem, injection: REPORTS.quarantine }).route).toBe('quarantine');
    expect(routeFinding({ ...problem, category: 'not-a-defect' }).route).toBe('discard');
    expect(routeFinding({ ...problem, repeat: { workItem: '1004', probability: REPORTS.repeat } })).toEqual({
      route: 'repeat',
      joined: '1004',
    });
  });
});

describe('what leaves the cluster of a report', () => {
  it('has no email addresses or long numbers', () => {
    expect(scrub('Write to me at jo.bloggs+shop@example.co.uk or call 07700 900 123, order 123456')).toBe(
      'Write to me at [email] or call [number], order [number]',
    );
  });

  it('finds an address however it is wrapped, and leaves what only looks like one', () => {
    expect(scrub('(me@shop.example), "you@b.example".')).toBe('([email]), "[email]".');
    expect(scrub('@mossops on social, or a@b')).toBe('@mossops on social, or a@b');
  });

  it('takes no longer than a pass over a hostile text', () => {
    const hostile = `${'!'.repeat(50_000)}@${'!'.repeat(50_000)}`;
    const started = performance.now();
    scrub(hostile);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('keeps short numbers and prices, which describe the page', () => {
    expect(scrub('Item 2 costs £-12.99 and page 3 of 10 repeats it')).toBe(
      'Item 2 costs £-12.99 and page 3 of 10 repeats it',
    );
  });

  it('keeps dates, which a content report may be about', () => {
    expect(scrub('The sale ends 2026-10-03 but the banner says 03-10-2026')).toBe(
      'The sale ends 2026-10-03 but the banner says 03-10-2026',
    );
  });

  it('takes anything private out of the path, which the visitor may have typed', () => {
    expect(privatePath('/account/jane.doe%40example.com/orders?x=1')).toBe('/account/[email]/orders');
    expect(privatePath('/track/447700900123')).toBe('/track/[number]');
    expect(privatePath('/products/brass-doorstop')).toBe('/products/brass-doorstop');
    expect(privatePath(`/${'a'.repeat(300)}`)).toHaveLength(200);
  });

  it('shortens a long path for a title, saying it was cut', () => {
    expect(shortPath('/about')).toBe('/about');
    expect(shortPath(`/${'a'.repeat(100)}`)).toMatch(/^\/a{58}…$/);
  });

  it('names the page without the query, which the visitor typed', () => {
    expect(pathOf('/search?q=my+name')).toBe('/search');
    expect(pathOf('/products/kettle#reviews')).toBe('/products/kettle');
    expect(pathOf('?q=x')).toBe('/');
  });
});
