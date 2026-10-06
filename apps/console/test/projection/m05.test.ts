/**
 * Milestone 5's states (the design system's README, "Fixing"), projected from the samples' last seven work items:
 * the spec and its scope, the rounds, the review thread, the gates by attempt, a round on the line, the wait for
 * Martin's merge, the four holds, a merge waiting for a release, a local model, and the describer's step.
 */
import type { PayloadOf } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { project, projectSheet } from '../../web/src/projection/index.ts';
import { END, SAMPLES, work } from './support.ts';

const view = project(SAMPLES, END);
const card = (number: string) => view.cards.find((c) => c.number === number);
const sheet = (number: string) => projectSheet(SAMPLES, number, END);

describe('the wait for Martin’s merge', () => {
  it('shows the pull request he is asked to merge, not the spec', () => {
    expect(card('1311')).toMatchObject({ outcome: 'needs-you', pullRequest: 1312 });
    expect(card('1311')?.picture).toEqual({
      type: 'merge',
      pullRequest: 1312,
      title: 'fix(basket): take quantities of any length',
      checks: { passed: 12, total: 12 },
      testsFirst: { failedOnBase: true, figure: '3 of 3' },
      review: { suggestions: 1, number: 2 },
      // The whole change a merge brings in, both rounds together; the second round's own files were fewer.
      files: 2,
      added: 30,
      removed: 5,
      inScope: true,
    });
  });

  it('keeps the problem’s own evidence in the sheet', () => {
    expect(sheet('1311')?.evidence.type).toBe('http');
  });

  it('is a row in Review’s panel, waiting for the merge', () => {
    expect(view.panels.review.rows.find((row) => row.item === '1311')).toMatchObject({
      note: 'Needs you · waiting for Martin’s merge',
      tone: 'attn',
    });
  });

  it('ends the rounds, saying since when', () => {
    expect(sheet('1311')?.after).toMatchObject({ outcome: 'needs-you' });
    expect(sheet('1311')?.after?.text).toMatch(/^Described, ready, and waiting for Martin’s merge since \d\d:\d\d$/);
  });
});

describe('a merged fix', () => {
  it('waits at Release for a release, in the quiet tone, with Review passed', () => {
    expect(card('1304')).toMatchObject({ outcome: 'merged', segments: [...Array(6).fill('passed'), 'queued', 'none'] });
    expect(view.stations.find((s) => s.stage === 'release')).toMatchObject({
      status: 'idle',
      figure: '1 waiting',
      queued: 1,
    });
    expect(view.panels.release.rows).toContainEqual(
      expect.objectContaining({ item: '1304', note: 'Merged · waiting for release', tone: 'faint' }),
    );
  });

  it('ends its story at the merge, drawn as work waiting', () => {
    expect(sheet('1304')?.chapters.at(-1)).toMatchObject({ label: 'MERGED', waiting: true, tone: 'faint' });
    expect(sheet('1304')?.chapters.map((c) => c.label)).not.toContain('NOW');
  });

  it('is merged by the merge alone: the line writes no answer to the wait', () => {
    const events = work('1')
      .open()
      .add(1, 'hold.started', 'factory', {
        stage: 'review',
        kind: 'approval',
        cause: 'merge',
        reason: 'Waits for the merge',
      })
      .add(2, 'pull-request.merged', 'martin', { number: 2, commit: 'b'.repeat(40), by: 'martin' }).events;
    const [merged] = project(events, work('1').at(3)).cards;
    expect(merged?.outcome).toBe('merged');
  });
});

describe('a fix held for a human', () => {
  it('by the scope fence: its own output, and the refusal before it', () => {
    expect(card('1315')?.picture).toMatchObject({
      type: 'scope',
      patch: 2,
      refusals: 2,
      earlier: { patch: 1, same: true },
      reachedGitHub: false,
    });
    expect(card('1315')?.picture).toHaveProperty('output', expect.stringContaining('refused src/catalogue.ts +9 −3'));
  });

  it('by the tests-first check: its own output, run on the base', () => {
    expect(card('1317')?.picture).toMatchObject({
      type: 'tests-pass',
      output: expect.stringContaining('0 of 2 new tests fail before the fix'),
    });
  });

  it('at its spend cap: what it spent, by agent, and the step it stopped', () => {
    const picture = card('1319')?.picture;
    expect(picture).toMatchObject({ type: 'spend', stage: 'build', cap: 5, stopped: { agent: 'coder', step: 2 } });
    if (picture?.type !== 'spend') throw new Error('not a spend picture');
    expect(picture.spent).toBeCloseTo(5.03, 2);
    expect(picture.agents.map((a) => [a.agent, a.steps])).toEqual([
      ['planner', 1],
      ['coder', 2],
      ['reviewer', 1],
    ]);
  });

  it('still blocking after two reviews: the open finding, its rule, and the reviews it blocked', () => {
    expect(card('1323')?.picture).toEqual({
      type: 'blocking',
      reviews: 2,
      findings: [
        {
          where: 'test/discount.test.ts:16',
          cites: 'rule 3, test at the seams',
          comment: 'The test still calls matchCode() directly instead of applying the code through the shop.',
          reviews: [1, 2],
        },
      ],
    });
  });
});

describe('the sheet of a fix', () => {
  it('says the describer wrote its story', () => {
    expect(sheet('1311')?.storyBy).toBe('describer');
    expect(sheet('1315')?.storyBy).toBeUndefined();
  });

  it('shows the spec’s scope with what the pull request changes in it, every round together', () => {
    expect(sheet('1311')?.scope).toEqual({
      of: { pullRequest: 1312 },
      rows: [
        { path: 'src/pages/basket.ts', added: 3, removed: 5, outside: false },
        { path: 'test/basket.test.ts', added: 27, removed: 0, outside: false },
        { path: 'test/support/shop.ts', added: undefined, removed: undefined, outside: false },
      ],
    });
  });

  it('shows a refused patch’s path outside the scope', () => {
    expect(sheet('1315')?.scope?.rows.at(-1)).toEqual({
      path: 'src/catalogue.ts',
      added: 9,
      removed: 3,
      outside: true,
    });
  });

  it('lists each attempt with its gates, its review, and the return between them', () => {
    const rounds = sheet('1311')?.rounds ?? [];
    // Each attempt's own files: the second round's are what it changed on top of the first.
    expect(rounds.map((a) => [a.attempt, a.how, a.files, a.added, a.removed])).toEqual([
      [1, 'tests first', 2, 22, 3],
      [2, 'resumed', 2, 17, 9],
    ]);
    expect(rounds[0]?.gates).toMatchObject({
      state: 'passed',
      passed: 12,
      total: 12,
      testsFirst: { failedOnBase: true, figure: '2 of 2' },
    });
    expect(rounds[0]?.review).toEqual({ number: 1, verdict: 'changes-requested', blocking: 2, suggestions: 1 });
    expect(rounds[0]?.returned).toEqual({ from: 'review', detail: '2 blocking' });
    expect(rounds[1]?.review).toMatchObject({ number: 2, verdict: 'approved' });
    expect(rounds[1]?.returned).toBeUndefined();
    expect(sheet('1311')?.facts.reviews).toEqual({ done: 2, of: 2 });
  });

  it('prints each finding’s rule in full, and a criterion in the spec’s words', () => {
    const [first] = sheet('1311')?.review ?? [];
    expect(first).toMatchObject({ number: 1, attempt: 1, verdict: 'changes-requested' });
    expect(first?.findings[0]?.rule).toEqual({
      number: 3,
      title: 'Test at the seams',
      text: expect.stringContaining('Tests go through the shop over HTTP'),
    });
    const [criterion] = sheet('1319')?.review[0]?.findings ?? [];
    expect(criterion?.criterion).toEqual({
      number: 2,
      text: 'GIVEN a wishlist of three WHEN one is removed THEN the other two stay',
    });
  });

  it('shows the gates of the attempt that counts, with the signals apart and a line for the one before', () => {
    const shown = sheet('1311');
    expect(shown?.gatesAttempt).toBe(2);
    expect(shown?.gates).toHaveLength(12);
    expect(shown?.gates.every((g) => g.required)).toBe(true);
    expect(shown?.signals.map((g) => [g.check, g.conclusion, g.summary])).toEqual([
      ['Tests first', 'success', '3 of 3 new tests fail on the base'],
      ['factory review', 'success', 'approved, review 2'],
    ]);
    expect(shown?.earlier).toEqual(['Attempt 1 passed every required check; the reviewer sent it back.']);
  });
});

describe('agents and models', () => {
  it('counts an agent’s steps, and puts the describer last', () => {
    const agents = sheet('1311')?.agents ?? [];
    expect(agents.map((a) => [a.agent, a.steps])).toEqual([
      ['planner', 1],
      ['coder', 2],
      ['reviewer', 2],
      ['describer', 1],
    ]);
    expect(agents[1]?.details).toEqual(['effort medium · ≤ 40 turns · 2 steps']);
  });

  it('says a local model served every call, at no cost', () => {
    expect(card('1304')).toMatchObject({ local: true, spend: 0 });
    expect(sheet('1304')?.agents.every((a) => a.provider === 'local' && a.model === 'qwen/qwen3.8-27b')).toBe(true);
    expect(card('1311')?.local).toBe(false);
  });
});

describe('a round on the line', () => {
  it('draws the return with the round and its blocking findings, as the line writes it', () => {
    expect(view.returns.map((r) => r.text)).toContain('#1311 · round 2 · 2 blocking');
  });
});

describe('a fix sent back by the gates and then by the reviewer', () => {
  it('counts reviews, not attempts, against the limit', () => {
    expect(sheet('1325')?.facts.reviews).toEqual({ done: 1, of: 2 });
    expect(sheet('1325')?.rounds.map((a) => [a.attempt, a.returned])).toEqual([
      [1, { from: 'gates', detail: '1 check failed' }],
      [2, { from: 'review', detail: '1 blocking' }],
    ]);
  });

  it('names the review apart from the attempt it reviewed', () => {
    expect(sheet('1325')?.review.map((r) => [r.number, r.attempt])).toEqual([[1, 2]]);
  });

  it('draws its last return from what the event records', () => {
    expect(view.returns.find((r) => r.item === '1325')).toMatchObject({
      text: '#1325 · round 3 · 1 blocking',
      detail: 'round 3 · 1 blocking',
    });
  });
});

/** A fix the line holds, from its events: the four holds whose pictures once were guessed from the evidence. */
describe('a hold’s picture, by its cause', () => {
  const SPEC = {
    outcome: 'Search takes any word',
    criteria: [{ given: 'a long word', when: 'it is searched', expect: 'it is found' }],
    scope: ['src/search.ts', 'test/'],
    risks: [],
    rollout: 'A normal release.',
  } satisfies PayloadOf<'spec.written'>;
  const FILES = [{ path: 'src/search.ts', added: 1, removed: 1 }];
  const PUSHED = {
    number: 9,
    title: 'fix(search): take any word',
    branch: 'factory/2-search',
    attempt: 1,
    testsFirst: false,
    files: FILES,
    whole: FILES,
  } satisfies PayloadOf<'pull-request.pushed'>;
  const refused = (path: string) =>
    ({
      mechanism: 'scope-fence',
      action: 'Push the coder’s round 1',
      output: `scope: src/search.ts, test/\nrefused ${path} +1 −1`,
      files: [{ path, added: 1, removed: 1, allowed: false }],
    }) satisfies PayloadOf<'action.refused'>;
  const held = (stage: PayloadOf<'hold.started'>['stage'], cause: PayloadOf<'hold.started'>['cause']) =>
    ({ stage, kind: 'held', cause, reason: 'Held for Martin' }) satisfies PayloadOf<'hold.started'>;
  const pictureOf = (events: ReturnType<typeof work>) => project(events.events, events.at(60)).cards[0]?.picture;
  const fix = () => work('2').open().add(1, 'spec.written', 'planner', SPEC);

  it('counts the fence’s refusals since Martin last answered, as the line does, not since the last push', () => {
    const events = fix()
      .add(2, 'action.refused', 'factory', refused('src/server.ts'))
      .add(3, 'pull-request.pushed', 'coder', PUSHED)
      .add(4, 'action.refused', 'factory', refused('src/server.ts'))
      .add(5, 'hold.started', 'factory', held('build', 'scope'));
    expect(pictureOf(events)).toMatchObject({
      type: 'scope',
      patch: 3,
      refusals: 2,
      earlier: { patch: 1, same: true },
    });
  });

  it('draws no fence for a step that failed after a refusal', () => {
    const events = fix()
      .add(2, 'action.refused', 'factory', refused('src/server.ts'))
      .add(5, 'hold.started', 'factory', held('build', 'failures'));
    expect(pictureOf(events)?.type).not.toBe('scope');
  });

  it('draws no tests-first picture for a required check that kept failing', () => {
    const commit = 'c'.repeat(40);
    const run = { pullRequest: 9, commit, durationMs: 1000 };
    const events = fix()
      .add(3, 'pull-request.pushed', 'coder', PUSHED)
      .add(4, 'gates.started', 'actions', { pullRequest: 9, commit, checks: ['Unit tests', 'Tests first'] })
      .add(5, 'gate.finished', 'actions', { ...run, check: 'Unit tests', conclusion: 'failure', required: true })
      .add(5, 'gate.finished', 'actions', { ...run, check: 'Tests first', conclusion: 'failure', required: false })
      .add(6, 'gates.finished', 'actions', {
        pullRequest: 9,
        commit,
        conclusion: 'failed',
        passed: 0,
        failed: ['Unit tests'],
      })
      .add(7, 'hold.started', 'factory', held('gates', 'gates'));
    expect(pictureOf(events)?.type).not.toBe('tests-pass');
  });

  it('draws no findings still blocking for a reviewer that kept failing', () => {
    const events = fix()
      .add(3, 'pull-request.pushed', 'coder', PUSHED)
      .add(4, 'review.submitted', 'reviewer', {
        pullRequest: 9,
        verdict: 'changes-requested',
        note: 'One thing to change.',
        findings: [{ path: 'src/search.ts', line: 3, blocking: true, rule: 3, comment: 'Test through the shop.' }],
      })
      .add(5, 'hold.started', 'factory', held('review', 'failures'));
    expect(pictureOf(events)?.type).not.toBe('blocking');
  });

  it('draws the spend cap the hold records, and nothing without one', () => {
    const events = fix().add(5, 'hold.started', 'factory', { ...held('build', 'spend'), limitUsd: 2 });
    expect(pictureOf(events)).toMatchObject({ type: 'spend', cap: 2 });
    expect(pictureOf(fix().add(5, 'hold.started', 'factory', held('build', 'spend')))?.type).not.toBe('spend');
  });
});
