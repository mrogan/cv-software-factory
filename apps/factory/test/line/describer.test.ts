import { describe, expect, it } from 'vitest';
import { type DescriberInput, describer, describerResult } from '../../src/line/agents/describer.ts';
import { FIXTURES } from '../../src/line/bench/fixtures.ts';

const input: DescriberInput =
  FIXTURES.describer['off-by-one']?.input ??
  (() => {
    throw new Error('The describer has no off-by-one fixture.');
  })();

const summary = {
  title: 'The last index was one too many',
  description: 'lastIndex gave one past a list’s last item. The fix waits for Martin to merge it.',
  story: 'A ticket said lastIndex gave the wrong result. The coder wrote a failing test, then the fix.',
};

describe('the describer', () => {
  it('names the visual-pr skill, and writes the description as a file of its own', () => {
    expect(describer.skill).toBe('visual-pr');
    expect(describer.resultFiles).toEqual({ body: 'description.md' });
  });

  it('is told the pull request, where the base is, the spec, and the review thread round by round', () => {
    const prompt = describer.prompt(input);
    expect(prompt).toContain(
      'Describe pull request #103, the factory’s fix for ticket #999999999: “fix(smoke): give the index of the last item, not one past it”.',
    );
    expect(prompt).toContain('`git diff base` is the change');
    expect(prompt).toContain(
      '1. Given a list of three items, when `lastIndex` is asked for its last index, then it returns 2.',
    );
    expect(prompt).toContain('the coder took 2 rounds.');
    expect(prompt).toContain('- Review 1 asked for changes: The test checks only an empty list');
    expect(prompt).toContain('  - Blocking at test/smoke.test.ts:5 (criterion 1): An empty list says nothing');
    expect(prompt).toContain('- Review 2 approved it: The test now shows criterion 1');
    expect(prompt).toContain('with the visual-pr skill');
    expect(prompt).toContain('{"title","summary":{"title","description","story"}}');
  });

  it('says one round when the first review approved', () => {
    const prompt = describer.prompt({ ...input, reviews: input.reviews.slice(1), returns: [] });
    expect(prompt).toContain('the coder took one round.');
    expect(prompt).not.toContain('went back to Build');
  });

  it('tells a later attempt why the last one failed, and what Martin answered', () => {
    const prompt = describer.prompt({ ...input, failure: 'body: no closing keyword', answer: 'Keep it short' });
    expect(prompt).toContain('Your last attempt at this description failed: body: no closing keyword.');
    expect(prompt).toContain('Martin answered the hold before this step: Keep it short');
    expect(describer.prompt(input)).not.toContain('last attempt');
  });

  it('takes a Conventional Commit title, a description and a summary the console can show', () => {
    const result = { title: 'fix(smoke): count the last index from zero', body: 'It counted from one.', summary };
    expect(describerResult.parse(result)).toEqual(result);
  });

  it('refuses a title that is not a Conventional Commit, an empty description, a description that closes an issue or mentions someone, or a story too long for the sheet', () => {
    const ok = { title: 'fix: count from zero', body: 'It counted from one.', summary };
    for (const wrong of [
      { ...ok, title: 'Count from zero' },
      { ...ok, body: '  ' },
      { ...ok, body: 'It counted from one.\n\nFixes #12' },
      { ...ok, body: 'It counted from one, as @someone saw.' },
      { ...ok, summary: { ...summary, story: 'x'.repeat(1201) } },
      { ...ok, extra: true },
    ]) {
      expect(describerResult.safeParse(wrong).success).toBe(false);
    }
  });
});
