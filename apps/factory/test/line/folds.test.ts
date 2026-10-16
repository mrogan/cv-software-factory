import { describe, expect, it } from 'vitest';
import { unrenderedFolds } from '../../src/line/agents/folds.ts';

// Each body that renders, or does not, did so in GitHub's own renderer (`gh api markdown`).
const lines = (...l: string[]) => l.join('\n');

describe('folded sections', () => {
  it('render with a blank line after each tag, and with none before </summary> or </details>', () => {
    for (const body of [
      lines('Why.', '', '<details>', '<summary>', '', '## Tests', '', '</summary>', '', '- passes', '', '</details>'),
      lines('<details open>', '<summary>', '', '## Tests', '</summary>', '', '- passes', '</details>', '', 'After.'),
      lines(
        '<details><summary>Plain words</summary>',
        '',
        '**Bold**, `code` and a [link](https://x.test).',
        '',
        '</details>',
      ),
      lines('- an item', '  <details>', '  <summary>', '', '  ## Nested', '', '  </summary>', '', '  </details>'),
      'No fold at all, and `<details>` in code, ``<details>`` too.',
      lines('Why.', '', '<!-- fold the tests in a <details> -->', '', '    <details>', '', 'Done.'),
    ]) {
      expect(unrenderedFolds(body), body).toEqual([]);
    }
  });

  it('name the line Markdown would be shown on as text, wherever a blank line is missing', () => {
    expect(
      unrenderedFolds(lines('<details>', '<summary>', '## Tests', '</summary>', '', '- a', '', '</details>')),
    ).toEqual(['a folded section shows “## Tests” as text: leave a blank line before it']);
    expect(
      unrenderedFolds(lines('<details>', '<summary>', '', '## Tests', '', '</summary>', '- a', '', '</details>')),
    ).toEqual(['a folded section shows “- a” as text: leave a blank line before it']);
    expect(
      unrenderedFolds(
        lines('<details>', '<summary>', '', '## T', '', '</summary>', '', '- a', '</details>', 'After **bold**'),
      ),
    ).toEqual(['a folded section shows “After **bold**” as text: leave a blank line before it']);
  });

  it('read a fold inside a quote, and after inline code that starts like a fence', () => {
    expect(unrenderedFolds(lines('> <details>', '> <summary>', '> ## T', '> </summary>', '', '> </details>'))).toEqual([
      'a folded section shows “## T” as text: leave a blank line before it',
    ]);
    expect(
      unrenderedFolds(
        lines('```npm test``` runs it.', '', '<details>', '<summary>', '## T', '</summary>', '', '</details>'),
      ),
    ).toEqual(['a folded section shows “## T” as text: leave a blank line before it']);
  });

  it('name Markdown on a tag’s own line', () => {
    expect(unrenderedFolds(lines('<details>', '<summary>## Tests</summary>', '', '- a', '', '</details>'))).toEqual([
      'a folded section shows “<summary>## Tests</summary>” as text: put the Markdown on a line of its own',
    ]);
  });

  it('name a section left open, and a close with nothing to close', () => {
    expect(unrenderedFolds(lines('<details>', '<summary>', '', '## T', '', '</summary>', '', '- a'))).toEqual([
      'a <details> is not closed, so the rest of the description folds into it',
    ]);
    expect(unrenderedFolds(lines('Why.', '', '</details>'))).toEqual(['a </details> closes no <details>']);
  });

  it('leave fenced code alone, which shows tags as text on purpose', () => {
    const body = lines(
      '```markdown',
      '<details>',
      '<summary>',
      '## Tests',
      '</summary>',
      '```',
      '',
      '~~~',
      '</details>',
      '~~~',
    );
    expect(unrenderedFolds(body)).toEqual([]);
  });
});
