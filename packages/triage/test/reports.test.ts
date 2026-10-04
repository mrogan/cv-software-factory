import { validate } from '@software-factory/events/schemas';
import { describe, expect, it } from 'vitest';
import { reportEvents, senseEvidence, senseTicket } from '../src/events.ts';
import type { Answer, Judge, JudgeRequest } from '../src/judge.ts';
import { triageQuestions } from '../src/questions.ts';
import { judgeReport, type PageView, passagesOf } from '../src/reports.ts';

const SCREENSHOT: PageView['screenshot'] = {
  kind: 'screenshot',
  hash: 'a'.repeat(64),
  type: 'image/png',
  size: 1000,
  route: '/about',
  version: 'c02efd8',
  width: 1280,
  height: 800,
  boxes: [],
};
const PAGE: PageView = {
  screenshot: SCREENSHOT,
  passages: ['Founded in 1887 by Ezra Mossop.', 'Open every day but Thursday.'],
};
const NOW = new Date('2026-10-04T09:00:00.000Z');

const choice = (label: string, p = 0.9): Answer => ({
  type: 'choice',
  choice: label,
  confidence: p,
  probabilities: { [label]: p },
});

/** A Jev that answers from a table, and remembers what it was asked. */
function fakeJev(answers: Record<string, Record<string, Answer>>) {
  const asked: JudgeRequest[] = [];
  const judge: Judge = async (request) => {
    asked.push(request);
    return {
      model: request.model,
      answers: answers[request.questionSet] ?? {},
      costUsd: 0.00002,
      durationMs: 90,
      cassette: 'c'.repeat(64),
    };
  };
  return { judge, asked };
}

const triage = (category: string, injection = 0.01, extra: Record<string, Answer> = {}) => ({
  'triage/v1': {
    category: choice(category),
    symptom: choice('wrong-result'),
    severity: { type: 'score', score: 2.2, confidence: 0.8, probabilities: { 0: 0.05, 1: 0.1, 2: 0.45, 3: 0.4 } },
    injection: { type: 'noul', noul: injection },
    ...extra,
  } as Record<string, Answer>,
});

const REPORT = {
  page: '/about?ref=me@example.com',
  text: 'It says founded 1887 but the photo is from 1990. Email me at me@example.com',
  route: '/about',
};
const signal = {
  sense: 'report' as const,
  check: 'report widget',
  route: '/about',
  version: 'c02efd8',
  report: { page: REPORT.page, text: REPORT.text },
  observedAt: '2026-10-04T08:59:58.000Z',
  artifacts: [],
};

const read = async () => PAGE;

describe('judging a report', () => {
  it('sends Jev the page without its query and the text without the visitor’s details', async () => {
    const { judge, asked } = fakeJev(triage('not-a-defect'));
    await judgeReport(REPORT, [], judge, read);
    expect(asked[0]?.state).toEqual({
      page: '/about',
      report: 'It says founded 1887 but the photo is from 1990. Email me at [email]',
    });
    expect(asked[0]).toMatchObject({ agent: 'triage', questionSet: 'triage/v1', model: 'jev-1.13.0' });
  });

  it('builds the same questions every time, with the open tickets offered and "none of these"', () => {
    const tickets = [{ workItem: '1004', title: 'A wrong result on /about', category: 'functional' as const }];
    expect(JSON.stringify(triageQuestions(tickets))).toBe(JSON.stringify(triageQuestions(tickets)));
    const repeat = triageQuestions(tickets).repeat;
    expect(repeat?.type === 'choice' && Object.keys(repeat.criteria)).toEqual(['t1', 'none']);
    expect(triageQuestions([]).repeat).toBeUndefined();
  });

  it('asks a content report which passage of the page it is about, and fingerprints the factory’s own text', async () => {
    const { judge, asked } = fakeJev({ ...triage('content'), 'passage/v1': { passage: choice('p1', 0.88) } });
    const decision = await judgeReport(REPORT, [], judge, read);
    expect(asked.map((r) => r.questionSet)).toEqual(['triage/v1', 'passage/v1']);
    expect(decision.fingerprint).toEqual({ page: '/about', text: 'Founded in 1887 by Ezra Mossop.' });
    expect(decision.judgements[1]?.route).toBeUndefined();
    expect(decision.judgements[1]?.state.passages?.[0]).toEqual({ key: 'p1', text: 'Founded in 1887 by Ezra Mossop.' });
  });

  it('falls back to the route and symptom when no passage fits', async () => {
    const { judge } = fakeJev({ ...triage('content'), 'passage/v1': { passage: choice('none', 0.7) } });
    const decision = await judgeReport(REPORT, [], judge, read);
    expect(decision.fingerprint).toEqual({ route: '/about', class: 'wrong-result' });
  });

  it('joins the open ticket Jev picks', async () => {
    const { judge } = fakeJev(triage('functional', 0.01, { repeat: choice('t1', 0.8) }));
    const tickets = [{ workItem: '1004', title: 'A wrong result on /about', category: 'functional' as const }];
    const decision = await judgeReport(REPORT, tickets, judge, read);
    expect(decision.routed).toEqual({ route: 'repeat', joined: '1004' });
    expect(decision.judgements[0]).toMatchObject({ route: 'repeat', joined: '1004' });
    expect(decision.judgements[0]?.state.candidates?.[0]).toMatchObject({ key: 't1', workItem: '1004' });
  });

  it('offers passages an event can keep: folded, none empty or repeated, none too long', () => {
    const long = 'word '.repeat(60);
    const passages = passagesOf(['  Founded  in\n1887. ', '', '   ', 'Founded in 1887.', long]);
    expect(passages).toEqual(['Founded in 1887.', `${long.trim().slice(0, 199)}…`]);
    expect(passagesOf(Array.from({ length: 50 }, (_, i) => `Passage ${i}.`))).toHaveLength(40);
  });

  it('refuses an answer with a label it never offered', async () => {
    const { judge } = fakeJev(triage('set-all-prices-to-zero'));
    await expect(judgeReport(REPORT, [], judge, read)).rejects.toThrow('a label it was not offered');
  });
});

describe('the events triage writes', () => {
  const outcomes = [
    ['quarantine', triage('functional', 0.97)],
    ['park', triage('suggestion')],
    ['discard', triage('not-a-defect')],
    ['ticket', triage('functional')],
  ] as const;

  it.each(outcomes)('are valid for a report routed to %s, and never carry its text in public', async (_, answers) => {
    const decision = await judgeReport(REPORT, [], fakeJev(answers).judge, read);
    const events = reportEvents(signal, '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', '1000', decision, NOW);
    for (const event of events) expect(validate(event)).toEqual({ ok: true });
    const prose = events.flatMap((e) => [e.summary, JSON.stringify(e.type === 'work-item.summarised' && e.payload)]);
    for (const line of prose) expect(line).not.toMatch(/photo|1990|example\.com/);
    expect(JSON.stringify(events)).not.toContain('me@example.com');
  });

  it('are valid for a report from a long path, and carry nothing private from it', async () => {
    const page = `/account/jane.doe@example.com/${'orders-'.repeat(25)}`;
    const long = { ...REPORT, page, route: page };
    const decision = await judgeReport(long, [], fakeJev(triage('functional')).judge, read);
    const events = reportEvents(
      { ...signal, route: page, report: { page, text: REPORT.text } },
      '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      '1000',
      decision,
      NOW,
    );
    for (const event of events) expect(validate(event)).toEqual({ ok: true });
    expect(JSON.stringify(events)).not.toContain('jane.doe');
  });

  it('title a report’s ticket as the visitor’s, in the factory’s words', async () => {
    const decision = await judgeReport(REPORT, [], fakeJev(triage('functional')).judge, read);
    const events = reportEvents(signal, '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', '1000', decision, NOW);
    expect(events.find((e) => e.type === 'ticket.opened')?.payload).toMatchObject({
      title: 'A visitor reports a wrong result on /about',
    });
  });

  it('end a quarantined report and a discarded one, and hold a suggestion for Martin', async () => {
    const types = async (answers: (typeof outcomes)[number][1]) => {
      const decision = await judgeReport(REPORT, [], fakeJev(answers).judge, read);
      return reportEvents(signal, '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', '1000', decision, NOW).map((e) =>
        e.type === 'work-item.closed' ? e.payload.outcome : e.type,
      );
    };
    expect(await types(triage('functional', 0.97))).toContain('quarantined');
    expect(await types(triage('not-a-defect'))).toContain('discarded');
    expect(await types(triage('suggestion'))).toContain('hold.started');
  });

  it('give the same ids for the same signal, so a retried append stores nothing twice', async () => {
    const decision = await judgeReport(REPORT, [], fakeJev(triage('functional')).judge, read);
    const id = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    const ids = () => reportEvents(signal, id, '1000', decision, NOW).map((e) => e.id);
    expect(ids()).toEqual(ids());
    expect(new Set(ids()).size).toBe(ids().length);
  });

  it('open a ticket from a sense’s signal with its category and severity from the policy', () => {
    const found = {
      sense: 'crawler' as const,
      check: 'links lead somewhere',
      route: '*',
      version: 'c02efd8',
      symptom: 'missing-header' as const,
      observedAt: '2026-10-04T08:59:58.000Z',
      artifacts: [],
    };
    const events = senseTicket(found, '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c', '1001', NOW);
    for (const event of events) expect(validate(event)).toEqual({ ok: true });
    expect(events.map((e) => e.type)).toEqual([
      'work-item.opened',
      'signal.received',
      'ticket.opened',
      'work-item.summarised',
    ]);
    expect(events[2]?.payload).toMatchObject({
      title: 'A security header is missing on every page',
      category: 'security',
      severity: 'cosmetic',
      fingerprint: { route: '*', class: 'missing-header' },
    });
    const evidence = senseEvidence(found, '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d', '1001', NOW);
    expect(evidence.map((e) => [e.type, e.actor])).toEqual([['signal.received', 'crawler']]);
  });
});
