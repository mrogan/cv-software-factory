import { describe, expect, it } from 'vitest';
import { cutAt, cutTo } from '../src/text.ts';

describe('cutting text to fit', () => {
  it('keeps text that fits as it is, and cuts the rest to its start and an ellipsis, the mark counted', () => {
    expect(cutTo('short', 5)).toBe('short');
    expect(cutTo('a longer line', 8)).toBe('a longe…');
    expect(cutTo('a longer line', 8)).toHaveLength(8);
    expect(cutTo('ab', 1)).toBe('…');
    // No space is left before the mark.
    expect(cutTo('abc   def', 5)).toBe('abc…');
  });

  it('cuts between characters, never inside one held as two units', () => {
    // The emoji's first half is the last character kept: it goes with its second.
    expect(cutTo('abc😀def', 5)).toBe('abc…');
    expect(cutTo('abc😀def', 6)).toBe('abc😀…');
    for (let max = 1; max < 12; max++) {
      const cut = cutTo('a😀b😀c😀d😀e', max);
      expect(cut.length).toBeLessThanOrEqual(max);
      expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    }
  });
});

describe('cutting a name to fit', () => {
  it('is a bare slice wherever the cut falls between characters, so a name cut before keeps its name', () => {
    for (const text of ['browser-error@/projects/:slug', 'café — naïve', '']) {
      for (let max = 0; max <= text.length + 1; max++) expect(cutAt(text, max)).toBe(text.slice(0, max));
    }
    expect(cutAt('abc😀def', 3)).toBe('abc');
    expect(cutAt('abc😀def', 5)).toBe('abc😀');
  });

  it('leaves out the first half of a character the cut would split, and adds no mark', () => {
    expect(cutAt('abc😀def', 4)).toBe('abc');
    expect(cutAt('abc😀def', 5)).toBe('abc😀');
    for (let max = 0; max < 12; max++) {
      const cut = cutAt('a😀b😀c😀d😀e', max);
      expect(cut.length).toBeLessThanOrEqual(max);
      expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    }
  });
});
