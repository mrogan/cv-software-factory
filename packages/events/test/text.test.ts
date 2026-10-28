import { describe, expect, it } from 'vitest';
import { cutTo } from '../src/text.ts';

describe('cutting text to fit', () => {
  it('keeps text that fits as it is, and cuts the rest to its start and an ellipsis, the mark counted', () => {
    expect(cutTo('short', 5)).toBe('short');
    expect(cutTo('a longer line', 8)).toBe('a longe…');
    expect(cutTo('a longer line', 8)).toHaveLength(8);
    expect(cutTo('ab', 1)).toBe('…');
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
