import type { NewEvent } from '@software-factory/events';
import { validate } from '@software-factory/events/schemas';
import { describe, expect, it } from 'vitest';
import { type GatewayRefusal, Refusals } from '../../src/gateway/refusals.ts';
import { capturingLog } from './helpers.ts';

const T0 = Date.parse('2026-10-31T12:00:00Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000);

/** The gateway's refusals, appended to a list, or to a store that is down. */
function harness({ down = false } = {}) {
  const appended: NewEvent[] = [];
  const captured = capturingLog();
  const events = {
    append: async (event: NewEvent | readonly NewEvent[]) => {
      if (down) throw new Error('The store is down');
      appended.push(...[event].flat());
      return [];
    },
  };
  return { appended, captured, refusals: new Refusals({ events: events as never, log: captured.log }) };
}

const capped = (seconds: number, workItem: string | null = '1001'): GatewayRefusal => ({
  workItem,
  cause: 'cap',
  action: 'A model call by the coder agent',
  output: `The work-item spend cap of $1.00 has been reached ($1.0${seconds % 10} spent).`,
  at: at(seconds),
});

describe('the gateway’s refusals', () => {
  it('records the first at once, as the gateway’s, with the guardrails its cause shows', async () => {
    const { appended, refusals } = harness();
    refusals.refused(capped(0));
    refusals.refused({ ...capped(0), cause: 'stopped', output: 'The line is stopped.' });
    refusals.refused({ ...capped(0), cause: 'policy', output: 'The triage agent does not call models.' });
    await refusals.settled();
    expect(appended.map((event) => validate(event))).toEqual(appended.map(() => ({ ok: true })));
    expect(
      appended.map(({ work_item, type, actor, ts, payload }) => ({ work_item, type, actor, ts, payload })),
    ).toEqual([
      {
        work_item: '1001',
        type: 'action.refused',
        actor: 'factory',
        ts: at(0).toISOString(),
        payload: {
          mechanism: 'gateway',
          action: 'A model call by the coder agent',
          output: 'The work-item spend cap of $1.00 has been reached ($1.00 spent).',
          guardrails: [7],
        },
      },
      expect.objectContaining({ payload: expect.objectContaining({ guardrails: [9] }) }),
      expect.objectContaining({ payload: expect.objectContaining({ guardrails: [6] }) }),
    ]);
  });

  it('folds a minute’s repeats into one event, with how many and the last one’s words, each minute', async () => {
    const { appended, refusals } = harness();
    for (const seconds of [0, 10, 20, 30]) refusals.refused(capped(seconds));
    // Another work item's, and a call no job names, are refusals of their own.
    refusals.refused(capped(5, '1002'));
    refusals.refused(capped(6, null));
    await refusals.flush(at(59));
    expect(appended.map((event) => [event.work_item, (event.payload as { count?: number }).count])).toEqual([
      ['1001', undefined],
      ['1002', undefined],
      [null, undefined],
    ]);
    await refusals.flush(at(60));
    const folded = appended.at(-1);
    expect(appended).toHaveLength(4);
    expect(validate(folded)).toEqual({ ok: true });
    expect(folded).toMatchObject({
      work_item: '1001',
      ts: at(10).toISOString(),
      summary: 'The gateway refused a model call at a spend cap, 3 times in a minute',
      payload: { count: 3, lastAt: at(30).toISOString(), output: expect.stringContaining('$1.00 spent') },
    });
    // The next is a first again.
    refusals.refused(capped(70));
    await refusals.settled();
    expect(appended).toHaveLength(5);
  });

  it('folds one cause apart from another, so a fold’s words and guardrails are its own', async () => {
    const { appended, refusals } = harness();
    refusals.refused(capped(0));
    refusals.refused({ ...capped(1), cause: 'stopped', output: 'The line is stopped.' });
    refusals.refused({ ...capped(2), cause: 'stopped', output: 'The line is stopped.' });
    refusals.refused(capped(3));
    await refusals.stop();
    expect(appended.map((event) => (event.payload as { guardrails: number[] }).guardrails)).toEqual([
      [7],
      [9],
      [9],
      [7],
    ]);
  });

  it('records what it still holds as it stops, whatever the time', async () => {
    const { appended, refusals } = harness();
    refusals.refused(capped(0));
    refusals.refused(capped(1));
    refusals.refused(capped(2));
    await refusals.stop();
    expect(appended).toHaveLength(2);
    expect(appended[1]?.payload).toMatchObject({ count: 2, lastAt: at(2).toISOString() });
  });

  it('logs a refusal the store will not take, and throws nothing', async () => {
    const { refusals, captured } = harness({ down: true });
    expect(() => refusals.refused(capped(0))).not.toThrow();
    await refusals.settled();
    expect(captured.text()).toMatch(/could not record the gateway’s refusal/);
  });

  it('keeps a long refusal to what the event holds', async () => {
    const { appended, refusals } = harness();
    refusals.refused({ ...capped(0), output: 'x'.repeat(5000), action: 'y'.repeat(300) });
    await refusals.settled();
    expect(validate(appended[0])).toEqual({ ok: true });
    expect((appended[0]?.payload as { output: string } | undefined)?.output).toHaveLength(4000);
  });
});
