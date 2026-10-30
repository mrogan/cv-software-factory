import { describe, expect, it } from 'vitest';
import { waitReason } from '../../src/line/worker.ts';

describe('why a work item waits', () => {
  it('says whom it waits for and the files they share', () => {
    expect(waitReason(['1028'], ['src/example.ts'])).toBe('Waits for #1028, whose spec also changes src/example.ts');
  });

  it('fits what an event keeps, ending in a mark, and never cuts inside an emoji', () => {
    const long = waitReason(['1028'], [`src/${'a'.repeat(400)}.ts`]);
    expect(long).toHaveLength(300);
    expect(long.endsWith('…')).toBe(true);
    const lead = 'Waits for #1028, whose spec also changes '.length;
    const emoji = waitReason(['1028'], [`${'a'.repeat(298 - lead)}😀${'b'.repeat(40)}`]);
    expect(emoji).toBe(`Waits for #1028, whose spec also changes ${'a'.repeat(298 - lead)}…`);
  });
});
