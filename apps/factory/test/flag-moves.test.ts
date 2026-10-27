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
const at = (stage: Stage | null, more: Partial<FlagNow> = {}): FlagNow => ({
  stage,
  workItem: '1316',
  baseline: true,
  ...more,
});
/** A flag at Checks or Preview whose check there since Martin's move has passed. */
const checked = (stage: typeof checks | typeof preview, more: Partial<FlagNow> = {}): FlagNow =>
  at(stage, { checked: { stage: stage.stage as 'checks' | 'preview', outcome: 'passed' }, ...more });

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
    expect(refused(checked(checks), preview)).toBeUndefined();
    expect(refused(checked(checks), share(50))).toBeUndefined();
    expect(refused(checked(preview), share(10))).toBeUndefined();
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
    const offFromEveryone = at(off, { stagedOn: '1316', last: { from: everyone, to: off } });
    expect(refused(offFromEveryone, everyone)).toBeUndefined();
    // Not for a later improvement whose spec reuses the flag: it widens from Checks.
    const reused = at(off, { workItem: '1400', stagedOn: '1316', last: { from: everyone, to: off } });
    expect(refused(reused, everyone)).toMatch(/Checks comes first/);
    expect(refused(reused, checks)).toBeUndefined();
    expect(refused(at(off, { last: { from: share(50), to: off } }), everyone)).toMatch(/Checks comes first/);
    expect(refused(at(off), everyone)).toMatch(/Checks comes first/);
  });

  it('keeps off a flag Martin turned off on its improvement, but for going straight back to Everyone', () => {
    const offFromPreview = at(off, { stagedOn: '1316', last: { from: preview, to: off } });
    expect(refused(offFromPreview, checks)).toMatch(/#1316 closes as turned off: it stays off/);
    expect(refused(offFromPreview, everyone)).toMatch(/Only a flag turned off from Everyone/);
    const offFromEveryone = at(off, { stagedOn: '1316', last: { from: everyone, to: off } });
    expect(refused(offFromEveryone, everyone)).toBeUndefined();
    expect(refused(offFromEveryone, checks)).toMatch(/#1316 closes as turned off/);
    // Back on, it narrows and turns off as any flag does.
    const backOn = at(everyone, { stagedOn: '1316', last: { from: off, to: everyone } });
    expect(refused(backOn, share(50))).toBeUndefined();
    expect(refused(backOn, off)).toBeUndefined();
    // The same flag, named by a later improvement's spec, widens afresh on that one.
    expect(
      refused(at(off, { workItem: '1400', stagedOn: '1316', last: { from: preview, to: off } }), checks),
    ).toBeUndefined();
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

  it('refuses Checks until Verify has a baseline of the improvement to compare its check there with', () => {
    expect(refused(at(off, { baseline: false }), checks)).toBe(
      'Verify has no picture of the app with the flag off yet: Checks can be taken once it has, so the check there has something to compare with.',
    );
    expect(refused(at(off), checks)).toBeUndefined();
    // Turning back on from Everyone, Off and narrowing never wait for it.
    const offFromEveryone = at(off, { baseline: false, stagedOn: '1316', last: { from: everyone, to: off } });
    expect(refused(offFromEveryone, everyone)).toBeUndefined();
    expect(refused(at(preview, { baseline: false }), checks)).toBeUndefined();
    expect(refused(at(checks, { baseline: false }), off)).toBeUndefined();
  });

  it('refuses a widening past Checks or Preview until Verify’s check there has passed', () => {
    expect(refused(at(checks), preview)).toBe(
      'Verify is still checking the flag at Checks: Preview can be taken once the check has passed.',
    );
    expect(refused(at(checks), share(50))).toBe(
      'Verify is still checking the flag at Checks: Share can be taken once the check has passed.',
    );
    expect(refused(at(preview), share(50))).toMatch(/still checking the flag at Preview: Share/);
    // A check at another stage is not of the flag as it stands: Preview's own comes after Martin's move there.
    expect(refused(at(preview, { checked: { stage: 'checks', outcome: 'passed' } }), share(50))).toMatch(
      /still checking/,
    );
    expect(refused(at(checks, { checked: { stage: 'checks', outcome: 'failed' } }), preview)).toBe(
      "Verify's check at Checks failed: Preview can't be taken. Turn it off.",
    );
    expect(refused(at(checks, { checked: { stage: 'checks', outcome: 'unsure' } }), share(25))).toBe(
      "Verify's check at Checks could not tell: Share can't be taken. Turn it off.",
    );
    expect(refused(at(preview, { checked: { stage: 'preview', outcome: 'failed' } }), share(50))).toBe(
      "Verify's check at Preview failed: Share can't be taken. Narrow it to Checks to check it again, or turn it off.",
    );
    expect(refused(at(preview, { checked: { stage: 'preview', outcome: 'unsure' } }), share(50))).toMatch(
      /could not tell/,
    );
    // Narrowing and Off are never held by it, nor a wider share, nor turning back on from Everyone.
    const failed = { checked: { stage: 'preview', outcome: 'failed' } } as const;
    expect(refused(at(preview, failed), checks)).toBeUndefined();
    expect(refused(at(preview, failed), off)).toBeUndefined();
    expect(refused(at(share(10)), share(50))).toBeUndefined();
    expect(refused(at(off, { stagedOn: '1316', last: { from: everyone, to: off } }), everyone)).toBeUndefined();
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
    const moves = movesOf('delivery-dates', checked(checks), { canary: { version: 'v0.9.13', weight: 25 } });
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
  it('is off once a spec names it, at the stage Martin last set, with Verify’s comparison of that move', () => {
    const flags = flagsFrom(
      [
        { type: 'flag.checked', flag: 'delivery-dates', stage: 'off', workItem: '1316' },
        { type: 'flag.staged', flag: 'delivery-dates', workItem: '1316', from: off, to: checks, revision: 'r1' },
        { type: 'flag.staged', flag: 'delivery-dates', workItem: '1316', from: checks, to: share(50), revision: 'r2' },
        { type: 'flag.compared', flag: 'delivery-dates', share: 50, outcome: 'passed', moveRevision: 'r2' },
        { type: 'flag.staged', flag: 'old-banner', workItem: '1200', from: everyone, to: off, revision: 'r3' },
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
        baseline: true,
      },
      'price-sort': { stage: off, workItem: '1330' },
      'old-banner': { stage: off, stagedOn: '1200', last: { from: everyone, to: off } },
    });
    expect(moveOf('delivery-dates', flags['delivery-dates'] as FlagNow, everyone).refused).toBeUndefined();
    // No spec names it now: it is staged no more, but turned off.
    expect(moveOf('old-banner', flags['old-banner'] as FlagNow, everyone).refused).toMatch(/No improvement's spec/);
    expect(moveOf('old-banner', { stage: checks, stagedOn: '1200' }, off).refused).toBeUndefined();
  });

  it('has Verify’s check at Checks or Preview of Martin’s move, and forgets it once he moves the flag again', () => {
    const records = [
      { type: 'flag.staged', flag: 'delivery-dates', workItem: '1316', from: off, to: checks, revision: 'r1' },
      { type: 'flag.checked', flag: 'delivery-dates', stage: 'checks', outcome: 'passed', moveRevision: 'r1' },
    ] as const;
    const flags = flagsFrom(records, { 'delivery-dates': '1316' });
    expect(flags['delivery-dates']?.checked).toEqual({ stage: 'checks', outcome: 'passed' });
    expect(moveOf('delivery-dates', flags['delivery-dates'] as FlagNow, preview).refused).toBeUndefined();
    const moved = flagsFrom(
      [
        ...records,
        { type: 'flag.staged', flag: 'delivery-dates', workItem: '1316', from: checks, to: preview, revision: 'r2' },
      ],
      { 'delivery-dates': '1316' },
    );
    expect(moved['delivery-dates']?.checked).toBeUndefined();
    expect(moveOf('delivery-dates', moved['delivery-dates'] as FlagNow, share(50)).refused).toMatch(/still checking/);
  });

  it('counts a judgement only for the move it names, however late it comes', () => {
    // A check started at Checks (r1), appended after Martin went to Preview and back to Checks (r3): none of r3's.
    const flags = flagsFrom([
      { type: 'flag.staged', flag: 'dates', workItem: '1316', from: off, to: checks, revision: 'r1' },
      { type: 'flag.staged', flag: 'dates', workItem: '1316', from: checks, to: preview, revision: 'r2' },
      { type: 'flag.staged', flag: 'dates', workItem: '1316', from: preview, to: checks, revision: 'r3' },
      { type: 'flag.checked', flag: 'dates', stage: 'checks', outcome: 'passed', moveRevision: 'r1' },
      // So a comparison of an earlier move at the same share.
      { type: 'flag.staged', flag: 'shared', workItem: '1317', from: checks, to: share(50), revision: 'r4' },
      { type: 'flag.staged', flag: 'shared', workItem: '1317', from: share(50), to: checks, revision: 'r5' },
      { type: 'flag.staged', flag: 'shared', workItem: '1317', from: checks, to: share(50), revision: 'r6' },
      { type: 'flag.compared', flag: 'shared', share: 50, outcome: 'passed', moveRevision: 'r4' },
    ]);
    expect(flags.dates?.checked).toBeUndefined();
    expect(flags.shared?.compared).toBeUndefined();
    // Another flag's later move leaves this one's judgement standing: it names this flag's move.
    const later = flagsFrom([
      { type: 'flag.staged', flag: 'dates', workItem: '1316', from: off, to: checks, revision: 'r1' },
      { type: 'flag.staged', flag: 'other', workItem: '1318', from: off, to: checks, revision: 'r2' },
      { type: 'flag.checked', flag: 'dates', stage: 'checks', outcome: 'passed', moveRevision: 'r1' },
    ]);
    expect(later.dates?.checked).toEqual({ stage: 'checks', outcome: 'passed' });
  });

  it('has a baseline only for the improvement whose spec names it now', () => {
    const records = [{ type: 'flag.checked', flag: 'dates', stage: 'off', workItem: '1316' }] as const;
    expect(flagsFrom(records, { dates: '1316' }).dates?.baseline).toBe(true);
    expect(flagsFrom(records, { dates: '1400' }).dates?.baseline).toBeUndefined();
  });

  it('forgets a comparison once Martin moves the flag again', () => {
    const flags = flagsFrom([
      { type: 'flag.staged', flag: 'delivery-dates', workItem: '1316', from: checks, to: share(50), revision: 'r1' },
      { type: 'flag.compared', flag: 'delivery-dates', share: 50, outcome: 'passed', moveRevision: 'r1' },
      { type: 'flag.staged', flag: 'delivery-dates', workItem: '1316', from: share(50), to: share(25), revision: 'r2' },
    ]);
    expect(flags['delivery-dates']?.compared).toBeUndefined();
  });
});
