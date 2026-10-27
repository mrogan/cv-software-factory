/**
 * Which stage a feature flag may move to, and why one can't be taken now (`policy/flag-moves.ts`): the rules the admin
 * service refuses a move by, and the console draws each stop of a flag's slider from.
 */
import { FLAG_SHARES, FLAG_STAGES } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { ACCESS } from '../../../policy/access.ts';
import {
  type FlagAction,
  type FlagNow,
  flagAction,
  flagsFrom,
  moveOf,
  movesOf,
  stageWords,
} from '../../../policy/flag-moves.ts';
import { EVERY_STAGE, SHARES, STAGES, type Stage } from '../../../policy/flags.ts';

const off: Stage = { stage: 'off' };
const checks: Stage = { stage: 'checks' };
const preview: Stage = { stage: 'preview' };
const share = (s: 10 | 25 | 50): Stage => ({ stage: 'share', share: s });
const everyone: Stage = { stage: 'everyone' };

/** A flag an improvement ships behind, at a stage. */
const at = (stage: Stage | null, more: Partial<FlagNow> = {}): FlagNow => ({ stage, workItem: '1316', ...more });

describe('the events’ words for the stages', () => {
  it('are policy’s', () => {
    expect([...FLAG_STAGES]).toEqual([...STAGES]);
    expect([...FLAG_SHARES]).toEqual([...SHARES]);
  });
});

describe('what a move is', () => {
  it('is an action in the access table, the passkey asked for every widening but Off to Checks', () => {
    const actions = new Set<FlagAction>();
    for (const from of [null, ...EVERY_STAGE]) {
      for (const to of EVERY_STAGE) {
        const action = flagAction(from, to);
        if (action) actions.add(action);
      }
    }
    expect([...actions].sort()).toEqual(['flag.back-on', 'flag.narrow', 'flag.off', 'flag.to-checks', 'flag.widen']);
    expect(ACCESS['flag.to-checks'].stepUp).toBe(false);
    expect(ACCESS['flag.widen'].stepUp).toBe(true);
    expect(ACCESS['flag.back-on'].stepUp).toBe(true);
    expect(ACCESS['flag.narrow'].stepUp).toBe(false);
    expect(ACCESS['flag.off'].stepUp).toBe(false);
  });

  it('is told from the stages alone', () => {
    expect(flagAction(off, checks)).toBe('flag.to-checks');
    expect(flagAction(checks, preview)).toBe('flag.widen');
    expect(flagAction(checks, share(50))).toBe('flag.widen');
    expect(flagAction(share(10), share(25))).toBe('flag.widen');
    expect(flagAction(share(50), share(10))).toBe('flag.narrow');
    expect(flagAction(off, everyone)).toBe('flag.back-on');
    expect(flagAction(everyone, checks)).toBe('flag.narrow');
    expect(flagAction(preview, off)).toBe('flag.off');
    // A flag in no stage's shape is taken as wide as it might be.
    expect(flagAction(null, checks)).toBe('flag.widen');
    expect(flagAction(null, off)).toBe('flag.off');
    expect(flagAction(share(25), share(25))).toBeUndefined();
    expect(flagAction(off, off)).toBeUndefined();
  });

  it('is said in the console’s words', () => {
    expect(EVERY_STAGE.map(stageWords)).toEqual([
      'Off',
      'Checks',
      'Preview',
      'Share 10%',
      'Share 25%',
      'Share 50%',
      'Everyone',
    ]);
  });
});

describe('a move', () => {
  const refused = (now: FlagNow, to: Stage, around = {}) => moveOf('delivery-dates', now, to, around).refused;

  it('widens one stage at a time, but Preview may be skipped', () => {
    expect(refused(at(off), checks)).toBeUndefined();
    expect(refused(at(checks), preview)).toBeUndefined();
    expect(refused(at(checks), share(50))).toBeUndefined();
    expect(refused(at(preview), share(10))).toBeUndefined();
    for (const [from, to] of [
      [off, preview],
      [off, share(50)],
      [checks, everyone],
      [preview, everyone],
    ] as const) {
      expect(refused(at(from), to), `${from.stage} → ${to.stage}`).toMatch(/stage at a time|Checks comes first/);
    }
  });

  it('narrows to any lower stage, and turns off from any, never refused', () => {
    for (const from of EVERY_STAGE) {
      for (const to of EVERY_STAGE) {
        const action = flagAction(from, to);
        if (action !== 'flag.narrow' && action !== 'flag.off') continue;
        // Even with a canary in flight, Verify comparing and another flag at Share, but for narrowing into Share.
        const around = { canary: { version: 'v0.9.13', weight: 50 }, atShare: 'price-sort' };
        const into = to.stage === 'share' && from.stage !== 'share';
        expect(refused(at(from), to, around) === undefined, `${stageWords(from)} → ${stageWords(to)}`).toBe(!into);
      }
    }
    // Off is never refused, even outside every stage.
    expect(refused(at(null), off)).toBeUndefined();
  });

  it('turns back on straight to Everyone only a flag turned off from Everyone', () => {
    const offFromEveryone = at(off, { last: { from: everyone, to: off } });
    expect(refused(offFromEveryone, everyone)).toBeUndefined();
    expect(refused(at(off, { last: { from: share(50), to: off } }), everyone)).toMatch(/Checks comes first/);
    expect(refused(at(off), everyone)).toMatch(/Checks comes first/);
  });

  it('keeps off a flag whose work item closed as turned off, but for going straight back to Everyone', () => {
    const closed = { closed: true, stagedOn: '1316' };
    const offFromPreview = at(off, { ...closed, last: { from: preview, to: off } });
    expect(refused(offFromPreview, checks)).toMatch(/#1316 closed as turned off: it stays off/);
    expect(refused(offFromPreview, everyone)).toMatch(/Only a flag turned off from Everyone/);
    const offFromEveryone = at(off, { ...closed, last: { from: everyone, to: off } });
    expect(refused(offFromEveryone, everyone)).toBeUndefined();
    expect(refused(offFromEveryone, checks)).toMatch(/#1316 closed as turned off/);
    // Back on, it narrows and turns off as any flag does.
    const backOn = at(everyone, { ...closed, last: { from: off, to: everyone } });
    expect(refused(backOn, share(50))).toBeUndefined();
    expect(refused(backOn, off)).toBeUndefined();
  });

  it('refuses Share while a canary is in flight, or that can’t be told, or another flag is at Share', () => {
    expect(refused(at(checks), share(50), { canary: { version: 'v0.9.13', weight: 50 } })).toBe(
      'v0.9.13 is at 50%, and its two versions would mix the two sides. Share can be taken once it ends.',
    );
    expect(refused(at(checks), share(50), { canary: 'unknown' })).toMatch(/can't be told/);
    expect(refused(at(checks), share(50), { atShare: 'price-sort' })).toBe(
      'price-sort is at Share: one flag at a time, so each comparison varies one thing.',
    );
    // A share changed while it is at Share is no move into it.
    expect(refused(at(share(10)), share(50), { canary: { version: 'v0.9.13', weight: 50 } })).toBeUndefined();
  });

  it('refuses Everyone until Verify’s comparison at the flag’s share has passed', () => {
    expect(refused(at(share(50)), everyone)).toMatch(/still comparing/);
    expect(refused(at(share(50), { compared: { share: 50, outcome: 'failed' } }), everyone)).toMatch(/failed/);
    // A comparison at another share is not of the flag as it stands.
    expect(refused(at(share(50), { compared: { share: 10, outcome: 'passed' } }), everyone)).toMatch(/comparing/);
    expect(refused(at(share(50), { compared: { share: 50, outcome: 'passed' } }), everyone)).toBeUndefined();
  });

  it('refuses a flag no improvement’s spec names, one outside every stage, a share not policy’s, and no move', () => {
    expect(refused({ stage: checks }, preview)).toMatch(/No improvement's spec names delivery-dates/);
    expect(refused({ stage: preview }, off)).toMatch(/No improvement's spec/);
    expect(refused(at(null), checks)).toMatch(/outside every stage: turn it off first/);
    expect(refused(at(checks), { stage: 'share', share: 30 } as unknown as Stage)).toBe('A share is 10, 25 or 50%.');
    expect(moveOf('delivery-dates', at(checks), checks)).toEqual({
      to: checks,
      action: undefined,
      refused: 'delivery-dates is at Checks already.',
    });
  });

  it('is judged for every stop of the slider, as the console draws them', () => {
    const moves = movesOf('delivery-dates', at(checks), { canary: { version: 'v0.9.13', weight: 25 } });
    expect(moves.map((m) => [stageWords(m.to), m.action, m.refused !== undefined])).toEqual([
      ['Off', 'flag.off', false],
      ['Checks', undefined, true],
      ['Preview', 'flag.widen', false],
      ['Share 10%', 'flag.widen', true],
      ['Share 25%', 'flag.widen', true],
      ['Share 50%', 'flag.widen', true],
      ['Everyone', 'flag.widen', true],
    ]);
  });
});

describe('a flag as its events tell it', () => {
  it('is off once a spec names it, at the stage Martin last set, with Verify’s comparison since', () => {
    const flags = flagsFrom(
      [
        { type: 'flag.staged', flag: 'delivery-dates', workItem: '1316', from: off, to: checks },
        { type: 'flag.staged', flag: 'delivery-dates', workItem: '1316', from: checks, to: share(50) },
        { type: 'flag.compared', flag: 'delivery-dates', share: 50, outcome: 'passed' },
        { type: 'flag.staged', flag: 'old-banner', workItem: '1200', from: everyone, to: off },
      ],
      { 'delivery-dates': '1316', 'price-sort': '1330' },
    );
    expect(flags).toEqual({
      'delivery-dates': {
        stage: share(50),
        workItem: '1316',
        stagedOn: '1316',
        last: { from: checks, to: share(50) },
        compared: { share: 50, outcome: 'passed' },
      },
      'price-sort': { stage: off, workItem: '1330' },
      'old-banner': { stage: off, stagedOn: '1200', last: { from: everyone, to: off } },
    });
    expect(moveOf('delivery-dates', flags['delivery-dates'] as FlagNow, everyone).refused).toBeUndefined();
    // No spec names it now: it is staged no more, but turned off.
    expect(moveOf('old-banner', flags['old-banner'] as FlagNow, everyone).refused).toMatch(/No improvement's spec/);
    expect(moveOf('old-banner', { stage: checks, stagedOn: '1200' }, off).refused).toBeUndefined();
  });

  it('says a flag whose work item closed as turned off is closed, on whatever move since', () => {
    const records = [
      { type: 'flag.staged', flag: 'last-one', workItem: '1316', from: everyone, to: off },
      { type: 'flag.staged', flag: 'last-one', workItem: '1316', from: off, to: everyone },
    ] as const;
    expect(flagsFrom(records, { 'last-one': '1316' }, ['1316'])['last-one']).toMatchObject({ closed: true });
    expect(flagsFrom(records, { 'last-one': '1316' })['last-one']?.closed).toBeUndefined();
  });

  it('forgets a comparison once Martin moves the flag again', () => {
    const flags = flagsFrom([
      { type: 'flag.staged', flag: 'delivery-dates', workItem: '1316', from: checks, to: share(50) },
      { type: 'flag.compared', flag: 'delivery-dates', share: 50, outcome: 'passed' },
      { type: 'flag.staged', flag: 'delivery-dates', workItem: '1316', from: share(50), to: share(25) },
    ]);
    expect(flags['delivery-dates']?.compared).toBeUndefined();
  });
});
