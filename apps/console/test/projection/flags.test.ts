/**
 * The feature flags as the console draws them (`projection/flags.ts`): each flag an improvement ships behind, from the
 * events, its slider's stops judged by the admin service's own rules (`policy/flag-moves.ts`), its card in Needs you,
 * the card's flag and the sheet's; and the samples' two flags. The move the confirmation sends is the one the admin
 * service takes, and the read of whether the app holds the flags is taken only whole.
 */
import type { PayloadOf } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { MOVE } from '../../../factory/src/admin/flags.ts';
import { isHeld } from '../../web/src/held.ts';
import { flagsView } from '../../web/src/projection/flags.ts';
import { project, projectSheet } from '../../web/src/projection/index.ts';
import { foldItems } from '../../web/src/projection/items.ts';
import { END, SAMPLES, work } from './support.ts';

const START = Date.parse('2026-10-03T09:00:00Z');

/** An improvement whose spec names a flag, released with it off, then whatever moves Martin makes. */
function improvement(number: string, flag: string, released = true) {
  const item = work(number, START)
    .open('improvement')
    .add(5, 'spec.written', 'planner', {
      outcome: 'Something new',
      criteria: [{ given: 'the flag is on', when: 'a page is shown', expect: 'it is new' }],
      scope: ['src/new.ts'],
      risks: [],
      rollout: 'Behind its flag',
      flag,
    });
  if (released) {
    item.add(60, 'release.promoted', 'rollouts', {
      release: `r-${number}`,
      version: 'v1.0.0',
      previous: 'v0.9.9',
      watched: true,
      dryRun: false,
    });
  }
  return item;
}

type Staged = PayloadOf<'flag.staged'>;
const staged = (flag: string, from: Staged['from'], to: Staged['to'], action: Staged['action'], reason?: string) => ({
  flag,
  from,
  to,
  action,
  revision: 'r1',
  steppedUp: action === 'flag.widen' || action === 'flag.back-on',
  ...(reason && { reason }),
});

const viewOf = (events: Parameters<typeof foldItems>[0], t = START + 1000 * 60_000) =>
  flagsView(events, foldItems(events), [], t);

describe('a flag', () => {
  it('shows once its release is out, off, with Checks the one stop it can widen to', () => {
    const before = improvement('2001', 'new-thing', false);
    expect(viewOf(before.events).flags).toEqual([]);
    const { flags, needs } = viewOf(improvement('2001', 'new-thing').events);
    expect(flags.map((row) => [row.name, row.workItem, row.stage.stage])).toEqual([['new-thing', '2001', 'off']]);
    const stops = flags[0]?.stops.map((stop) => [stop.stage, stop.place, stop.move.action, Boolean(stop.move.refused)]);
    expect(stops).toEqual([
      ['off', 'now', undefined, true],
      ['checks', 'ahead', 'flag.to-checks', false],
      ['preview', 'ahead', 'flag.widen', true],
      ['share', 'ahead', 'flag.widen', true],
      ['everyone', 'ahead', 'flag.back-on', true],
    ]);
    // Released and still off, it waits for Martin, with no Turn off: it is off already.
    expect(needs).toMatchObject([
      { flag: 'new-thing', kicker: 'Shipped behind its flag', widen: { to: { stage: 'checks' } } },
    ]);
    expect(needs[0]?.turnOff).toBeUndefined();
  });

  it('may skip Preview from Checks, and no other stage', () => {
    const item = improvement('2002', 'skip').add(
      70,
      'flag.staged',
      'martin',
      staged('skip', { stage: 'off' }, { stage: 'checks' }, 'flag.to-checks'),
    );
    const [row] = viewOf(item.events).flags;
    const refused = Object.fromEntries(row?.stops.map((stop) => [stop.stage, stop.move.refused]) ?? []);
    expect(refused.preview).toBeUndefined();
    expect(refused.share).toBeUndefined();
    expect(refused.everyone).toMatch(/One stage at a time/);
    expect(row?.stops.find((stop) => stop.stage === 'off')?.move.action).toBe('flag.off');
  });

  it('waits at Share while Verify compares, with no card, and Everyone refused until the comparison passes', () => {
    const item = improvement('2003', 'shared').add(
      70,
      'flag.staged',
      'martin',
      staged('shared', { stage: 'preview' }, { stage: 'share', share: 25 }, 'flag.widen'),
    );
    const comparing = viewOf(item.events);
    expect(comparing.flags[0]).toMatchObject({ share: 25, comparison: 'comparing' });
    expect(comparing.flags[0]?.stops.at(-1)?.move.refused).toMatch(/still comparing/);
    expect(comparing.needs).toEqual([]);
    expect(foldItems(item.events)[0]?.outcome).toBe('in-progress');

    item.add(120, 'flag.compared', 'factory', {
      flag: 'shared',
      share: 25,
      window: { from: new Date(START).toISOString(), to: new Date(START + 1).toISOString() },
      setAsideMinutes: 0,
      outcome: 'passed',
      sides: {
        on: { requests: 412, errorRate: 0.0097, p99Ms: 41 },
        off: { requests: 398, errorRate: 0.0101, p99Ms: 40 },
      },
    });
    const compared = viewOf(item.events);
    expect(compared.flags[0]?.comparison).toBe('passed');
    expect(compared.needs[0]).toMatchObject({
      kicker: 'Ready to widen',
      widen: { to: { stage: 'everyone' }, action: 'flag.widen' },
    });
    expect(compared.needs[0]?.widen.refused).toBeUndefined();
    expect(compared.needs[0]?.evidence).toContain(
      'errors 0.97% and 1.01%, p99 41 ms and 40 ms, over 412 and 398 requests',
    );
    // Waiting for Martin to widen, its outcome is Needs you.
    expect(foldItems(item.events)[0]?.outcome).toBe('needs-you');
  });

  it('turned off from Everyone may go straight back, with the passkey, and stays among the flags', () => {
    const item = improvement('2004', 'back')
      .add(
        70,
        'flag.staged',
        'martin',
        staged('back', { stage: 'share', share: 50 }, { stage: 'everyone' }, 'flag.widen'),
      )
      .add(
        80,
        'flag.staged',
        'martin',
        staged('back', { stage: 'everyone' }, { stage: 'off' }, 'flag.off', 'Wrong on Sundays'),
      )
      .add(81, 'work-item.closed', 'factory', { outcome: 'verified', reason: 'Verified' });
    const { flags, closed } = viewOf(item.events);
    expect(closed).toEqual([]);
    expect(flags[0]).toMatchObject({ backOn: true, turnedOff: true });
    expect(flags[0]?.stops.at(-1)?.move).toMatchObject({ action: 'flag.back-on' });
    expect(flags[0]?.stops.at(-1)?.move.refused).toBeUndefined();
  });

  it('turned off before everyone had it, its work item closed, folds under Turned off and closed', () => {
    const item = improvement('2005', 'gone')
      .add(70, 'flag.staged', 'martin', staged('gone', { stage: 'off' }, { stage: 'checks' }, 'flag.to-checks'))
      .add(80, 'flag.staged', 'martin', staged('gone', { stage: 'checks' }, { stage: 'off' }, 'flag.off', 'Not needed'))
      .add(81, 'work-item.closed', 'factory', { outcome: 'no-change', reason: 'Turned off' });
    const { flags, closed, needs } = viewOf(item.events);
    expect(flags).toEqual([]);
    expect(closed.map((row) => row.name)).toEqual(['gone']);
    expect(needs).toEqual([]);
  });

  it('believes only Martin’s moves, which only his roles can append', () => {
    const item = improvement('2006', 'forged').add(
      70,
      'flag.staged',
      'coder',
      staged('forged', { stage: 'off' }, { stage: 'everyone' }, 'flag.back-on'),
    );
    expect(viewOf(item.events).flags[0]?.stage.stage).toBe('off');
  });

  it('waits for Martin only once its release is out, as its card does', () => {
    const early = improvement('2009', 'early', false).add(
      70,
      'flag.staged',
      'martin',
      staged('early', { stage: 'off' }, { stage: 'checks' }, 'flag.to-checks'),
    );
    expect(viewOf(early.events).needs).toEqual([]);
    expect(foldItems(early.events)[0]?.outcome).not.toBe('needs-you');
  });

  it('belongs to the work item whose spec named it last, as the admin service reads it', () => {
    const older = improvement('2010', 'other');
    const newer = improvement('2011', 'shared-name');
    // The older improvement's spec is written again, later, naming the same flag.
    older.add(200, 'spec.written', 'planner', {
      outcome: 'Something new, again',
      criteria: [{ given: 'the flag is on', when: 'a page is shown', expect: 'it is new' }],
      scope: ['src/new.ts'],
      risks: [],
      rollout: 'Behind its flag',
      flag: 'shared-name',
    });
    const events = [...older.events, ...newer.events].sort((a, b) => a.seq - b.seq);
    expect(viewOf(events).flags.find((row) => row.name === 'shared-name')?.workItem).toBe('2010');
  });

  it('holds Share for a flag while another is at it', () => {
    const one = improvement('2007', 'one').add(
      70,
      'flag.staged',
      'martin',
      staged('one', { stage: 'preview' }, { stage: 'share', share: 50 }, 'flag.widen'),
    );
    const two = improvement('2008', 'two').add(
      70,
      'flag.staged',
      'martin',
      staged('two', { stage: 'checks' }, { stage: 'preview' }, 'flag.widen'),
    );
    const [, row] = viewOf([...one.events, ...two.events]).flags;
    expect(row?.stops.find((stop) => stop.stage === 'share')?.move.refused).toBe(
      'one is at Share: one flag at a time, so each comparison varies one thing.',
    );
  });
});

describe('the samples’ flags', () => {
  const view = project(SAMPLES, END);

  it('are last-one, on for everyone, and delivery-dates at Preview, Share held by the canary in flight at 50%', () => {
    expect(view.flags.flags.map((row) => [row.name, row.workItem, row.stage.stage])).toEqual([
      ['last-one', '1271', 'everyone'],
      ['delivery-dates', '1294', 'preview'],
    ]);
    const share = view.flags.flags[1]?.stops.find((stop) => stop.stage === 'share');
    expect(share?.move.refused).toBe(
      'v0.9.13 is at 50%, and its two versions would mix the two sides. Share can be taken once it ends.',
    );
    expect(view.flags.needs).toMatchObject([
      { flag: 'delivery-dates', kicker: 'Ready to widen', widen: { to: { stage: 'share', share: 50 } } },
    ]);
  });

  it('draw the flag on its card and its sheet: the stage on the card, the fact, the chapters and a block per move', () => {
    expect(view.cards.find((card) => card.number === '1294')).toMatchObject({
      outcome: 'needs-you',
      flag: { name: 'delivery-dates', stage: 'preview' },
    });
    // An improvement whose spec waits has no flag on its card, and its fact says so.
    expect(view.cards.find((card) => card.number === '1300')?.flag).toBeUndefined();
    expect(projectSheet(SAMPLES, '1300', END)?.facts.flag).toBe('sort-by-price · not built yet');

    const sheet = projectSheet(SAMPLES, '1271', END);
    expect(sheet?.facts.flag).toBe('last-one · everyone');
    expect(sheet?.chapters.map((c) => c.label)).toEqual(
      expect.arrayContaining(['CHECKS', 'PREVIEW', 'SHARE', 'COMPARED', 'EVERYONE']),
    );
    expect(sheet?.chapters.find((c) => c.label === 'PREVIEW')?.text).toBe(
      'Martin widened last-one from Checks to Preview, with his passkey',
    );
    expect(sheet?.chapters.find((c) => c.label === 'CHECKS')?.text).toBe('Martin widened last-one from Off to Checks');
    expect(sheet?.flag?.blocks.map((b) => (b.kind === 'released' ? 'released' : b.stage.stage))).toEqual([
      'everyone',
      'share',
      'preview',
      'checks',
      'released',
    ]);
    const share = sheet?.flag?.blocks[1];
    expect(share?.kind === 'staged' && share.compared?.outcome).toBe('passed');
  });
});

describe('what the console sends and reads', () => {
  it('sends a move as the admin service takes it', () => {
    expect(MOVE.safeParse({ from: { stage: 'preview' }, to: { stage: 'share', share: 50 } }).success).toBe(true);
    expect(
      MOVE.safeParse({ from: { stage: 'checks' }, to: { stage: 'off' }, reason: 'Wrong on Sundays' }).success,
    ).toBe(true);
  });

  it('takes the read of whether the app holds the flags only whole', () => {
    const held = { state: 'held', revision: 'r6', held: ['r6'], since: null, checkedAt: '2026-10-06T14:23:00.000Z' };
    expect(isHeld(held)).toBe(true);
    expect(isHeld({ ...held, state: 'fine' })).toBe(false);
    expect(isHeld({ ...held, held: [6] })).toBe(false);
    expect(isHeld({ ...held, checkedAt: 'yesterday' })).toBe(false);
    expect(isHeld({ ...held, revision: undefined })).toBe(false);
  });
});
