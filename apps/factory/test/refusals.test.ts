import { validate } from '@software-factory/events/schemas';
import { describe, expect, it } from 'vitest';
import { FOLD_MS, type FoldedRefusal, type Refusal, RefusalFolder } from '../src/refusals.ts';

const T0 = Date.parse('2026-10-31T12:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms);

const refusal = (ms: number, overrides: Partial<Refusal['payload']> = {}, workItem: string | null = '1400') =>
  ({
    workItem,
    at: at(ms),
    payload: {
      mechanism: 'gateway',
      action: 'Call claude-opus-5-5 for the coder',
      output: `The work item's cap of $5.00 is reached (${ms} ms)`,
      guardrails: [7],
      ...overrides,
    },
  }) satisfies Refusal;

/** Each folded refusal as an event the store would take. */
const valid = (folded: FoldedRefusal[]) =>
  folded.map(({ workItem, at, payload }) =>
    validate({
      id: crypto.randomUUID(),
      ts: at.toISOString(),
      work_item: workItem,
      type: 'action.refused',
      version: 3,
      actor: 'factory',
      summary: 'The gateway refused a call',
      payload,
      artifacts: [],
    }),
  );

describe('folding refusals', () => {
  it('gives back the first of a kind at once, as it came', () => {
    const folder = new RefusalFolder();
    const first = folder.add(refusal(0));
    expect(first).toEqual([{ workItem: '1400', at: at(0), payload: refusal(0).payload }]);
    expect(valid(first)).toEqual([{ ok: true }]);
    expect(folder.due(at(FOLD_MS))).toEqual([]);
  });

  it('folds the repeats within its minute into one, in the latest’s words, with how many and when the last was', () => {
    const folder = new RefusalFolder();
    folder.add(refusal(0));
    for (const ms of [1_000, 20_000, 59_999]) expect(folder.add(refusal(ms))).toEqual([]);
    expect(folder.held).toBe(3);
    expect(folder.due(at(FOLD_MS - 1))).toEqual([]);
    const folded = folder.due(at(FOLD_MS));
    expect(folded).toEqual([
      {
        workItem: '1400',
        at: at(1_000),
        payload: { ...refusal(59_999).payload, count: 3, lastAt: at(59_999).toISOString() },
      },
    ]);
    expect(valid(folded)).toEqual([{ ok: true }]);
    expect(folder.held).toBe(0);
    // The minute is over: the next is a first again.
    expect(folder.add(refusal(70_000))).toHaveLength(1);
  });

  it('gives back a single repeat as one refusal, with no count', () => {
    const folder = new RefusalFolder();
    folder.add(refusal(0));
    folder.add(refusal(5_000));
    const folded = folder.due(at(FOLD_MS));
    expect(folded).toEqual([{ workItem: '1400', at: at(5_000), payload: refusal(5_000).payload }]);
    expect(valid(folded)).toEqual([{ ok: true }]);
  });

  it('keeps refusals of another mechanism, work item or action apart', () => {
    const folder = new RefusalFolder();
    expect(folder.add(refusal(0))).toHaveLength(1);
    expect(folder.add(refusal(1, {}, '1401'))).toHaveLength(1);
    expect(folder.add(refusal(2, {}, null))).toHaveLength(1);
    expect(folder.add(refusal(3, { action: 'Call claude-opus-5-5 for the planner' }))).toHaveLength(1);
    expect(folder.add(refusal(4, { mechanism: 'scope-fence', guardrails: [11] }))).toHaveLength(1);
    expect(folder.add(refusal(5))).toEqual([]);
    expect(folder.held).toBe(1);
  });

  it('gives back a minute passed unasked before the refusal that opens the next', () => {
    const folder = new RefusalFolder();
    folder.add(refusal(0));
    folder.add(refusal(10_000));
    folder.add(refusal(30_000));
    const given = folder.add(refusal(90_000));
    expect(given).toEqual([
      {
        workItem: '1400',
        at: at(10_000),
        payload: { ...refusal(30_000).payload, count: 2, lastAt: at(30_000).toISOString() },
      },
      { workItem: '1400', at: at(90_000), payload: refusal(90_000).payload },
    ]);
  });

  it('holds a loop to at most two events a minute, however many times it is refused', () => {
    const folder = new RefusalFolder();
    const appended: FoldedRefusal[] = [];
    for (let ms = 0; ms < 10 * FOLD_MS; ms += 100) {
      appended.push(...folder.add(refusal(ms)));
      if (ms % 15_000 === 0) appended.push(...folder.due(at(ms)));
    }
    appended.push(...folder.drain());
    expect(appended.length).toBeLessThanOrEqual(20);
    expect(appended.reduce((sum, folded) => sum + (folded.payload.count ?? 1), 0)).toBe((10 * FOLD_MS) / 100);
    expect(valid(appended).every((result) => result.ok)).toBe(true);
  });

  it('gives back everything it holds as the worker stops, oldest first', () => {
    const folder = new RefusalFolder();
    folder.add(refusal(0, {}, '1401'));
    folder.add(refusal(1_000));
    folder.add(refusal(2_000));
    folder.add(refusal(3_000, {}, '1401'));
    expect(folder.drain().map((folded) => [folded.workItem, folded.at])).toEqual([
      ['1400', at(2_000)],
      ['1401', at(3_000)],
    ]);
    expect(folder.held).toBe(0);
    expect(folder.drain()).toEqual([]);
  });

  it('folds within the window it is given', () => {
    const folder = new RefusalFolder({ ms: 1_000 });
    folder.add(refusal(0));
    folder.add(refusal(500));
    expect(folder.due(at(1_000))).toHaveLength(1);
  });
});
