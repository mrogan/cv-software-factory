import { describe, expect, it } from 'vitest';
import {
  EVERY_STAGE,
  flag,
  flagsSpec,
  REVISION_FLAG,
  readFlags,
  revisionFlag,
  SHARES,
  STAGES,
  type Stage,
  stageOf,
} from '../../../policy/flags.ts';

/**
 * policy/flags.ts: the stages' shapes, as flagd reads them. Whether the cluster admits each, and refuses what is not
 * one, is flag-fences.test.ts's, from the cluster's answers.
 */
const variants = { on: true, off: false };
const marked = [{ '==': [{ var: 'marked' }, true] }, 'on'];

describe('a feature flag at each stage', () => {
  it('is off with no targeting: there, never deleted', () => {
    expect(flag('big-buttons', { stage: 'off' })).toEqual({ state: 'ENABLED', variants, defaultVariant: 'off' });
  });

  it('is on for the marked requests at checks', () => {
    expect(flag('big-buttons', { stage: 'checks' })).toEqual({
      state: 'ENABLED',
      variants,
      defaultVariant: 'off',
      targeting: { if: [...marked, 'off'] },
    });
  });

  it('is on for those and the requests whose preview names it at preview', () => {
    expect(flag('big-buttons', { stage: 'preview' }).targeting).toEqual({
      if: [...marked, { in: ['big-buttons', { var: 'preview' }] }, 'on', 'off'],
    });
  });

  it('is on for those and a share of the signed requests, by their id, at share', () => {
    for (const share of SHARES) {
      expect(flag('big-buttons', { stage: 'share', share }).targeting).toEqual({
        if: [
          ...marked,
          { in: ['big-buttons', { var: 'preview' }] },
          'on',
          { '==': [{ var: 'signed' }, true] },
          {
            fractional: [
              ['on', share],
              ['off', 100 - share],
            ],
          },
          'off',
        ],
      });
    }
  });

  it('is on by default, with no targeting, for everyone', () => {
    expect(flag('big-buttons', { stage: 'everyone' })).toEqual({ state: 'ENABLED', variants, defaultVariant: 'on' });
  });

  it('keeps the stages before it', () => {
    const targets = (stage: Stage) => (flag('big-buttons', stage).targeting?.if as unknown[]) ?? [];
    const order = [targets({ stage: 'checks' }), targets({ stage: 'preview' }), targets({ stage: 'share', share: 25 })];
    for (let i = 1; i < order.length; i++) {
      const before = order[i - 1] ?? [];
      // Every condition and its answer, all but the last `off`, is in the next stage, in its place.
      expect(order[i]?.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
    }
    expect(STAGES).toEqual(['off', 'checks', 'preview', 'share', 'everyone']);
  });

  it('refuses a name that is not a feature’s, the revision’s among them, and a share that is not one', () => {
    for (const name of ['Big-Buttons', 'big_buttons', '-big', 'big-', 'big--buttons', '', '__proto__', REVISION_FLAG]) {
      expect(() => flag(name, { stage: 'off' }), name).toThrow(/name/);
    }
    expect(() => flag('big-buttons', { stage: 'share', share: 30 } as unknown as Stage)).toThrow(/share/);
    expect(() => flag('big-buttons', { stage: 'on' } as unknown as Stage)).toThrow(/stage/);
  });
});

describe('the revision', () => {
  it('is one static string variant', () => {
    expect(revisionFlag('2026-10-26T08:00:00Z-1')).toEqual({
      state: 'ENABLED',
      variants: { revision: '2026-10-26T08:00:00Z-1' },
      defaultVariant: 'revision',
    });
  });

  it('is never a word the app keeps for no revision, nor one it would not report as it is', () => {
    for (const revision of ['none', 'stale', 'invalid', '', 'a b', 'é', 'x'.repeat(129)]) {
      expect(() => revisionFlag(revision), revision).toThrow(/revision/);
    }
    expect(revisionFlag('x'.repeat(128)).variants.revision).toHaveLength(128);
  });
});

describe('the whole of flags', () => {
  it('is every flag at its stage, by name, and the revision', () => {
    expect(flagsSpec({ 'dark-mode': { stage: 'everyone' }, 'big-buttons': { stage: 'checks' } }, 'r1')).toEqual({
      flagSpec: {
        flags: {
          'big-buttons': flag('big-buttons', { stage: 'checks' }),
          'dark-mode': flag('dark-mode', { stage: 'everyone' }),
          [REVISION_FLAG]: revisionFlag('r1'),
        },
      },
    });
    expect(flagsSpec({}, 'r1')).toEqual({ flagSpec: { flags: { [REVISION_FLAG]: revisionFlag('r1') } } });
  });

  it('refuses a stage for the revision, and a revision that is not one', () => {
    expect(() => flagsSpec({ [REVISION_FLAG]: { stage: 'off' } }, 'r1')).toThrow(/name/);
    expect(() => flagsSpec({ 'big-buttons': { stage: 'off' } }, 'none')).toThrow(/revision/);
  });
});

describe('flags read back', () => {
  it('gives every stage it renders, and the revision', () => {
    const stages = Object.fromEntries(EVERY_STAGE.map((stage, i): [string, Stage] => [`flag-${i}`, stage]));
    expect(readFlags(flagsSpec(stages, 'r1'))).toEqual({ stages, revision: 'r1', outside: [] });
    expect(EVERY_STAGE).toHaveLength(7);
  });

  it('names any flag in no shape, and reads nothing from what is not a flag set', () => {
    const { flagSpec } = flagsSpec({ 'big-buttons': { stage: 'checks' } }, 'r1');
    const flags: Record<string, unknown> = {
      ...flagSpec.flags,
      'dark-mode': { ...flag('dark-mode', { stage: 'off' }), metadata: { x: 1 } },
      'wide-share': { ...flag('wide-share', { stage: 'share', share: 50 }), targeting: { if: ['on'] } },
      // Another flag's preview: a stage's shape names its own flag.
      'own-name': flag('other-name', { stage: 'preview' }),
      Bad_Name: flag('bad-name', { stage: 'off' }),
    };
    expect(readFlags({ flagSpec: { flags } })).toEqual({
      stages: { 'big-buttons': { stage: 'checks' } },
      revision: 'r1',
      outside: ['Bad_Name', 'dark-mode', 'own-name', 'wide-share'],
    });
    const reserved = {
      [REVISION_FLAG]: { state: 'ENABLED', variants: { revision: 'none' }, defaultVariant: 'revision' },
    };
    expect(readFlags({ flagSpec: { flags: reserved } })).toEqual({ stages: {}, outside: [REVISION_FLAG] });
    expect(readFlags({ flagSpec: { flags: {} } })).toEqual({ stages: {}, outside: [] });
    expect(readFlags(undefined)).toEqual({ stages: {}, outside: [] });
  });

  it('takes a flag whose keys are in another order as its stage', () => {
    const { targeting, defaultVariant, state } = flag('big-buttons', { stage: 'share', share: 10 });
    expect(stageOf('big-buttons', { targeting, defaultVariant, variants: { off: false, on: true }, state })).toEqual({
      stage: 'share',
      share: 10,
    });
    expect(
      stageOf('big-buttons', { ...flag('big-buttons', { stage: 'everyone' }), state: 'DISABLED' }),
    ).toBeUndefined();
  });
});
