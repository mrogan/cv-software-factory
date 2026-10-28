/**
 * The one rule every reader holds an improvement to: Martin asked for it, by his roles, and it is no sample.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type NewEvent, VERSIONS } from '@software-factory/events';
import type { Sql } from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { DiskArtifacts } from '../src/artifacts.ts';
import { askedByMartin, openedAsImprovement } from '../src/commands.ts';
import { EventWriter, nextWorkItem } from '../src/events.ts';
import { type Database, freshDatabase } from './database.ts';

let database: Database | undefined;
afterEach(() => database?.end());

const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-')));

const event = (workItem: string, type: 'work-item.opened' | 'improvement.requested', sample: boolean): NewEvent =>
  ({
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    work_item: workItem,
    type,
    version: VERSIONS[type],
    actor: 'martin',
    summary: `${type} for the test`,
    payload:
      type === 'work-item.opened'
        ? { kind: 'improvement', title: 'Delivery dates', sample }
        : { words: 'Delivery dates.', steppedUp: true },
    artifacts: [],
  }) as NewEvent;

/** An improvement, opened and asked for by `opener`, and by `requester` (none, no request), as samples or real. */
async function improvement(
  db: Database,
  {
    opener = db.admin,
    requester = db.admin,
    sample = false,
  }: { opener?: Sql; requester?: Sql | null; sample?: boolean },
): Promise<string> {
  const workItem = await nextWorkItem(db.admin);
  const kind = sample ? 'sample' : 'real';
  const forged = opener !== db.admin || (requester !== null && requester !== db.admin);
  if (forged) await db.owner`alter table events disable row level security`;
  try {
    await new EventWriter(opener, { kind, artifacts }).append(event(workItem, 'work-item.opened', sample));
    if (requester)
      await new EventWriter(requester, { kind, artifacts }).append(event(workItem, 'improvement.requested', sample));
  } finally {
    if (forged) await db.owner`alter table events enable row level security`;
  }
  return workItem;
}

const asked = async (db: Database, workItem: string) => {
  const [row] = await db.as.line<{ asked: boolean; opened: boolean }[]>`
    select ${askedByMartin(db.as.line, 'w.work_item')} as asked, ${openedAsImprovement(db.as.line, 'w.work_item')} as opened
    from (select ${workItem}::text as work_item) w`;
  return row;
};

describe('an improvement Martin asked for', () => {
  it('is one his roles opened and asked for, and no other', async () => {
    database = await freshDatabase('commands');
    const db = database;
    expect(await asked(db, await improvement(db, {}))).toEqual({ asked: true, opened: true });
    expect(await asked(db, await improvement(db, { requester: null }))).toEqual({ asked: false, opened: true });
    // A worker's opening, or a worker's request, with row security off as a failed guard would leave it.
    expect(await asked(db, await improvement(db, { opener: db.as.triage }))).toEqual({ asked: false, opened: true });
    expect(await asked(db, await improvement(db, { requester: db.as.triage }))).toEqual({ asked: false, opened: true });
    expect(await asked(db, '999')).toEqual({ asked: false, opened: false });
  });

  it('is never a sample, though his roles wrote it', async () => {
    database = await freshDatabase('commands_samples');
    const db = database;
    expect(await asked(db, await improvement(db, { sample: true }))).toEqual({ asked: false, opened: true });
  });
});
