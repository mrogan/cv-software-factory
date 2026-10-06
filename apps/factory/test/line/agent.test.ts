import { describe, expect, it } from 'vitest';
import { closesAnIssue, commitTitle, mentions } from '../../src/line/agents/agent.ts';

describe('a fix’s title', () => {
  it('is a Conventional Commit of a fix’s type', () => {
    expect(commitTitle.parse(' fix(cart): count the last item ')).toBe('fix(cart): count the last item');
    for (const wrong of ['Count the last item', 'feat(cart): count the last item', 'fix(Cart): count it', 'fix: ']) {
      expect(commitTitle.safeParse(wrong).success, wrong).toBe(false);
    }
  });

  it('is 80 characters at most, however long its scope', () => {
    const title = (length: number, scope = 'a'.repeat(50)) => {
      const head = `fix(${scope}): `;
      return head + 'b'.repeat(length - head.length);
    };
    expect(commitTitle.safeParse(title(80)).success).toBe(true);
    expect(commitTitle.safeParse(title(81)).success).toBe(false);
    expect(commitTitle.safeParse(title(81, 'cart')).success).toBe(false);
  });
});

describe('what a published text may not do from the App’s account', () => {
  it('closes no issue, by any of GitHub’s closing keywords and references', () => {
    for (const closing of [
      'Fixes #1234',
      'This closes #12.',
      'fixed: #3',
      'Resolves mrogan/cv-worlds-worst-website#7',
      'CLOSED GH-9',
      'resolve https://github.com/mrogan/cv-worlds-worst-website/issues/4',
      'It came from a ticket.\n\n`fixes #5`',
    ]) {
      expect(closesAnIssue(closing), closing).toBe(true);
    }
    for (const fine of ['Refers to #41.', 'It fixes the price on #-less pages.', 'fix(cart): count the last item']) {
      expect(closesAnIssue(fine), fine).toBe(false);
    }
    expect(commitTitle.safeParse('fix(cart): resolve #12, the last item').success).toBe(false);
  });

  it('mentions nobody outside code', () => {
    for (const mention of ['Thanks @mrogan.', '@octocat, have a look', 'Ask (@org/team) first.']) {
      expect(mentions(mention), mention).toBe(true);
    }
    for (const fine of [
      'Mail martin@example.com.',
      'It imports `@software-factory/events`.',
      '```ts\nimport { z } from "@zod/mini";\n@decorator\n```',
      'An @ on its own.',
    ]) {
      expect(mentions(fine), fine).toBe(false);
    }
  });
});
