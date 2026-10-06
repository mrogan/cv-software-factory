import { describe, expect, it } from 'vitest';
import { type CoderInput, coder, coderInputAfterRefusal, fenceFor } from '../../src/line/agents/coder.ts';
import { FIXTURES } from '../../src/line/bench/fixtures.ts';

const input: CoderInput =
  FIXTURES.coder['wrong-price']?.input ??
  (() => {
    throw new Error('The coder has no wrong-price fixture.');
  })();

const FENCED = 'scope: src/money.ts, test/money.test.ts\nallowed src/money.ts +1 −1\nrefused src/pages/cards.ts +3 −1';

describe('the coder', () => {
  it('is told the ticket, its evidence and the spec, with the scope as a fence, and to write the test first', () => {
    const prompt = coder.prompt(input);
    expect(prompt).toContain('Fix ticket #999999999: A wrong result on /products/:slug.');
    expect(prompt).toContain('It is a wrong-result on /products/:slug. Category functional, severity broken.');
    expect(prompt).toContain('A probe\'s check "a price is in pounds and two digits of pence" on /products/:slug');
    expect(prompt).toContain('1. Given a price of 600 pence, when pounds is called with it, then it returns £6.00.');
    expect(prompt).toContain(
      'Scope, the only files you may change: src/money.ts, test/money.test.ts, test/pages-product.test.ts.',
    );
    expect(prompt).toContain('Read AGENTS.md first');
    expect(prompt).toMatch(/Write the test first.*see it fail/);
    expect(prompt).toContain('The line refuses a patch that changes any file outside the scope, whole.');
  });

  it('hands back a Conventional Commit title and a note for the commit', () => {
    const note = 'pounds wrote the pence without padding. A test for 705 pence shows it; it pads them now.';
    expect(coder.schema(input).safeParse({ title: 'fix(money): show two digits of pence', note }).success).toBe(true);
    for (const wrong of [
      { title: 'Fixed the price', note },
      { title: 'feat(money): pad pence', note },
      { title: 'fix(money): pad pence', note: '' },
      { title: 'fix(money): pad pence', note: 'x'.repeat(1001) },
      { title: 'fix(money): pad pence' },
    ]) {
      expect(coder.schema(input).safeParse(wrong).success, JSON.stringify(wrong).slice(0, 60)).toBe(false);
    }
  });

  it('is sent back by the scope fence with its output, told its checkout is fresh, and resumes its session', () => {
    const back = coderInputAfterRefusal(input, FENCED, 's');
    expect(coder.resume?.(back)).toBe('s');
    const prompt = coder.prompt(back);
    expect(prompt).toContain('The line refused your patch');
    expect(prompt).toContain('    refused src/pages/cards.ts +3 −1');
    expect(prompt).toContain('the checkout is back where you started');
    // Its session holds the rest; the spec is told again, since the planner may have written it afresh.
    expect(prompt).not.toContain('Read AGENTS.md first');
    expect(prompt).toContain('Scope, the only files you may change: src/money.ts');
    // Without one, it is told everything again.
    const fresh = coderInputAfterRefusal(input, FENCED, null);
    expect(coder.resume?.(fresh)).toBeUndefined();
    expect(coder.prompt(fresh)).toContain('Read AGENTS.md first');
  });

  it('is sent back by the gates or review to the pull request’s head, told everything again without its session', () => {
    const returned = { from: 'review' as const, reason: 'Review asked for changes: the test calls pounds only' };
    const resumed = { ...input, round: 2, returned, session: 's' };
    expect(coder.resume?.(resumed)).toBe('s');
    expect(coder.prompt(resumed)).toContain('came back from review, for round 2: Review asked for changes');
    expect(coder.prompt(resumed)).toContain(
      'The checkout is the pull request’s head, with the change you pushed before in it.',
    );
    expect(coder.prompt(resumed)).not.toContain('Read AGENTS.md first');
    const fresh = { ...input, round: 2, returned, session: null };
    expect(coder.resume?.(fresh)).toBeUndefined();
    expect(coder.prompt(fresh)).toContain('came back from review');
    expect(coder.prompt(fresh)).toContain('Read AGENTS.md first');
  });

  it('starts a first step afresh, whatever session it has', () => {
    expect(coder.resume?.({ ...input, session: 's' })).toBeUndefined();
  });

  it('is told why a returned round came back and why the fence refused it, without its session', () => {
    const returned = { from: 'review' as const, reason: 'Review asked for changes: the test calls pounds only' };
    const back = coderInputAfterRefusal({ ...input, round: 2, returned }, FENCED, null);
    expect(coder.resume?.(back)).toBeUndefined();
    const prompt = coder.prompt(back);
    expect(prompt).toContain(
      'came back from review, for round 2: Review asked for changes: the test calls pounds only.',
    );
    expect(prompt).toContain('The checkout is the pull request’s head, with the change you pushed before in it.');
    expect(prompt).toContain('The line refused your patch for this round');
    expect(prompt).toContain('    refused src/pages/cards.ts +3 −1');
    expect(prompt).toContain('the checkout is back where this round started');
    expect(prompt).toContain('Read AGENTS.md first');
  });

  it('is given Martin’s answer to the hold before its step', () => {
    expect(coder.prompt({ ...input, answer: 'Use the money helper' })).toContain(
      'Martin answered: Use the money helper',
    );
    const back = coderInputAfterRefusal({ ...input, answer: 'Use the money helper' }, FENCED, 's');
    expect(coder.prompt(back)).toContain('Martin answered: Use the money helper');
  });

  it('fences its patch to the scope and to the protected paths it was given', () => {
    const patch = (path: string) =>
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
    expect(fenceFor(patch('src/money.ts'), input).ok).toBe(true);
    const owned = fenceFor(patch('src/money.ts'), { ...input, protectedPaths: ['src/money.ts'] });
    expect(owned).toMatchObject({ ok: false, outside: ['src/money.ts'] });
  });
});
