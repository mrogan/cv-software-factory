import { describe, expect, it } from 'vitest';
import { bounded, cutTo } from '../src/log.ts';

describe('cutting a runner’s text to fit', () => {
  it('keeps text that fits, and cuts the rest to its start and an ellipsis, the mark counted', () => {
    expect(cutTo('short', 5)).toBe('short');
    expect(cutTo('a longer line', 8)).toBe('a longe…');
    expect(cutTo('abc   def', 5)).toBe('abc…');
    expect(bounded('x'.repeat(5000))).toHaveLength(4000);
  });

  it('never cuts inside an emoji', () => {
    expect(cutTo('abc😀def', 5)).toBe('abc…');
    expect(bounded(`${'x'.repeat(3998)}😀 and more`)).toBe(`${'x'.repeat(3998)}…`);
  });
});
