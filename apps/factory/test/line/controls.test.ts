/**
 * Martin's controls of the line, within policy (`policy/line.ts`): what is in force from whatever an event says, and
 * which of the access table's actions each change is.
 */
import { describe, expect, it } from 'vitest';
import { ACCESS } from '../../../../policy/access.ts';
import {
  type ControlChange,
  controlAction,
  controlsInForce,
  DEFAULT_CONTROLS,
  TAKE,
  type Take,
} from '../../../../policy/line.ts';
import { takesOf } from '../../src/line/queue.ts';

const SINCE = '2026-10-24T09:00:00.000Z';
const every: Take = { kind: 'every' };
const next = (count: number): Take => ({ kind: 'next-few', count, since: SINCE });
const one = (workItem: string): Take => ({ kind: 'just-one', workItem });

describe('the controls in force', () => {
  it('are policy’s defaults before Martin sets any: Supervised, new work, no auto-merge, and no take', () => {
    expect(controlsInForce()).toEqual({ ...DEFAULT_CONTROLS, outside: [] });
    expect(DEFAULT_CONTROLS).toEqual({ autonomy: 'supervised', newWork: true, autoMerge: false, take: null });
  });

  it('are what the latest event says, within policy', () => {
    const chosen = { autonomy: 'guarded', newWork: false, autoMerge: true, take: next(3) };
    expect(controlsInForce(chosen)).toEqual({ ...chosen, outside: [] });
    expect(controlsInForce({ ...chosen, take: one('1290') }).take).toEqual(one('1290'));
    expect(controlsInForce({ ...chosen, take: next(TAKE.most) }).take).toEqual(next(TAKE.most));
  });

  it('leave out anything outside policy, field by field, for policy’s default', () => {
    const chosen = { autonomy: 'guarded', newWork: false, autoMerge: true };
    for (const take of [
      next(0),
      next(TAKE.most + 1),
      next(2.5),
      { kind: 'next-few', count: 3 },
      { kind: 'next-few', count: 3, since: 'yesterday' },
      one('0'),
      one('12a'),
      { kind: 'all' },
      'every',
    ]) {
      expect(controlsInForce({ ...chosen, take }), JSON.stringify(take)).toEqual({
        ...chosen,
        take: null,
        outside: ['take'],
      });
    }
    expect(controlsInForce({ autonomy: 'yolo', newWork: 'yes', autoMerge: 1, take: null })).toEqual({
      ...DEFAULT_CONTROLS,
      outside: ['autonomy', 'newWork', 'autoMerge'],
    });
    expect(controlsInForce('guarded')).toEqual({ ...DEFAULT_CONTROLS, outside: [] });
  });
});

describe('what the line takes', () => {
  const defaults = { only: '1288', take: 13 };

  it('is Martin’s take, or with none in force, the line’s own default', () => {
    expect(takesOf(null, defaults)).toEqual({ only: '1288', take: { most: 13, since: null } });
    expect(takesOf(null, { only: null, take: null })).toEqual({ only: null, take: null });
    expect(takesOf(every, defaults)).toEqual({ only: null, take: null });
    expect(takesOf(next(3), defaults)).toEqual({ only: null, take: { most: 3, since: SINCE } });
    expect(takesOf(one('1290'), defaults)).toEqual({ only: '1290', take: null });
  });
});

describe('each change', () => {
  const change = (control: ControlChange['control'], before: unknown, after: unknown) =>
    controlAction({ control, before, after } as ControlChange);

  it('loosens autonomy towards Lights-out, and tightens it towards Supervised', () => {
    expect(change('autonomy', 'supervised', 'guarded')).toBe('autonomy.loosen');
    expect(change('autonomy', 'supervised', 'lights-out')).toBe('autonomy.loosen');
    expect(change('autonomy', 'lights-out', 'guarded')).toBe('autonomy.tighten');
    expect(change('autonomy', 'guarded', 'supervised')).toBe('autonomy.tighten');
  });

  it('turns each switch on or off', () => {
    expect(change('new-work', true, false)).toBe('new-work.off');
    expect(change('new-work', false, true)).toBe('new-work.on');
    expect(change('auto-merge', false, true)).toBe('auto-merge.on');
    expect(change('auto-merge', true, false)).toBe('auto-merge.off');
  });

  it('widens a take to more kinds of work or a larger number, and narrows it the other way', () => {
    expect(change('take', one('1290'), next(3))).toBe('take.widen');
    expect(change('take', next(3), every)).toBe('take.widen');
    expect(change('take', one('1290'), every)).toBe('take.widen');
    expect(change('take', next(3), next(4))).toBe('take.widen');
    expect(change('take', every, next(20))).toBe('take.narrow');
    expect(change('take', next(3), one('1290'))).toBe('take.narrow');
    expect(change('take', next(4), next(3))).toBe('take.narrow');
    // The same number again, counted from later, lets the line take that many more.
    expect(change('take', next(3), { kind: 'next-few', count: 3, since: '2026-10-24T10:00:00.000Z' })).toBe(
      'take.widen',
    );
    // Even in the same millisecond, as the admin service stamps it to the microsecond.
    expect(
      change(
        'take',
        { kind: 'next-few', count: 3, since: '2026-10-24T10:00:00.000100Z' },
        { kind: 'next-few', count: 3, since: '2026-10-24T10:00:00.000200Z' },
      ),
    ).toBe('take.widen');
    // Just one, moved to another work item, is still one.
    expect(change('take', one('1290'), one('1291'))).toBe('take.narrow');
  });

  it('widens whatever it sets over the line’s own default, which policy cannot see', () => {
    for (const after of [every, next(1), one('1290')]) expect(change('take', null, after)).toBe('take.widen');
  });

  it('asks for the passkey again exactly when it loosens, as the access table marks', () => {
    const loosens = ['autonomy.loosen', 'auto-merge.on', 'take.widen'];
    for (const action of [
      'autonomy.loosen',
      'autonomy.tighten',
      'new-work.on',
      'new-work.off',
      'auto-merge.on',
      'auto-merge.off',
      'take.widen',
      'take.narrow',
    ] as const) {
      expect(ACCESS[action].stepUp, action).toBe(loosens.includes(action));
    }
  });
});
