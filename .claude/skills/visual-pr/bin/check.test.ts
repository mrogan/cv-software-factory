import { describe, expect, it } from 'vitest';
import { problems } from './check.ts';

// GitHub's renderings of these bodies, as `gh api markdown` returned them, cut to what the checks read.
const FOLDED =
  '<details>\n<summary>\n<h2 dir="auto">Tests</h2>\n</summary>\n<ul dir="auto">\n<li>passes</li>\n</ul>\n</details>';

describe('check.ts', () => {
  it('passes a folded section whose summary is one heading', () => {
    expect(problems('', FOLDED, false)).toEqual([]);
  });

  it('names a summary left as Markdown, and the Markdown left as text', () => {
    const html = '<details open="">\n<summary>\n## Tests\n</summary>\n- `make check` passes\n</details>';
    expect(problems('', html, false)).toEqual([
      'a summary is not one heading (blank lines around a "## title"?): ## Tests',
      'Markdown left as text: ## Tests',
      'Markdown left as text: - `make check` passes',
    ]);
  });

  it('names a section with no summary', () => {
    expect(problems('', '<details>\n<p dir="auto">body</p>\n</details>', false)).toEqual([
      'a <details> has no <summary>, or one has two',
    ]);
  });

  it('names a local path left in a published body, in each form, and not one shown as code', () => {
    const body = [
      '[![blink](/Users/martin/scratch/pr/a/b.svg)](https://github.com/x)',
      '[snapshot](scratch/pr/foo.svg)',
      '[ref]: ./scratch/pr/c.svg',
      '<img src="scratch/pr/d.svg">',
      '`[![alt](<svg>)](https://github.com/x)`',
      '```markdown\n[x](scratch/in-code.svg)\n```',
      '[docs](https://docs.github.com) [up](#tests) <a href="mailto:a@b.c">mail</a>',
    ].join('\n\n');
    expect(problems(body, '', true)).toEqual([
      'a local path is left: /Users/martin/scratch/pr/a/b.svg',
      'a local path is left: scratch/pr/foo.svg',
      'a local path is left: ./scratch/pr/c.svg',
      'a local path is left: scratch/pr/d.svg',
    ]);
  });

  it('leaves local paths alone before the body is published', () => {
    expect(problems('[snapshot](scratch/pr/foo.svg)', '', false)).toEqual([]);
  });
});
