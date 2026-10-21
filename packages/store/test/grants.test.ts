/**
 * The store's grants are exactly those `policy/store-grants.ts` sets out: a grant that grows, a role that gains one or
 * a membership that changes fails here until the table says so. Then what each worker's role may and may not do, as
 * the worker would try it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InboxSignal, NewEvent } from '@software-factory/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STORE_GRANTS } from '../../../policy/store-grants.ts';
import { DiskArtifacts } from '../src/artifacts.ts';
import { EventWriter } from '../src/events.ts';
import { sendSignal } from '../src/inbox.ts';
import { type Database, freshDatabase } from './database.ts';
import { WORKERS } from './postgres.ts';

let db: Database;

beforeAll(async () => {
  db = await freshDatabase('grants');
});

afterAll(() => db?.end());

/** `insert (b, a)` as `insert (a, b)`, so the table may name columns in any order. */
const normal = (grant: string) => {
  const [, privilege, columns] = /^(\w+)(?: \((.+)\))?$/.exec(grant) ?? [];
  if (!privilege) throw new Error(`${grant} is not a privilege, or one with columns`);
  return columns ? `${privilege} (${columns.split(/,\s*/).sort().join(', ')})` : privilege;
};

interface Granted {
  role: string;
  object: string;
  privilege: string;
  columns: string[] | null;
}

/** Every grant on a table, view or sequence in the store's schema, but its owner's, as `policy/store-grants.ts` puts it. */
async function granted(): Promise<Record<string, Record<string, string[]>>> {
  const rows = await db.owner<Granted[]>`
    with objects as (
      select c.oid, c.relname, c.relowner, c.relacl from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
    )
    select coalesce(r.rolname, 'PUBLIC') as role, o.relname as object, lower(a.privilege_type) as privilege,
           null::text[] as columns
    from objects o cross join aclexplode(o.relacl) a left join pg_roles r on r.oid = a.grantee
    where a.grantee <> o.relowner
    union all
    select coalesce(r.rolname, 'PUBLIC'), o.relname, lower(a.privilege_type), array_agg(att.attname::text)
    from objects o join pg_attribute att on att.attrelid = o.oid and att.attnum > 0 and not att.attisdropped
    cross join aclexplode(att.attacl) a left join pg_roles r on r.oid = a.grantee
    where a.grantee <> o.relowner
    group by 1, 2, 3`;
  const found: Record<string, Record<string, string[]>> = {};
  for (const row of rows) {
    found[row.role] ??= {};
    const on = found[row.role] as Record<string, string[]>;
    on[row.object] = [
      ...(on[row.object] ?? []),
      normal(row.columns ? `${row.privilege} (${row.columns})` : row.privilege),
    ];
  }
  return found;
}

describe('the grants', () => {
  it('are exactly those policy/store-grants.ts sets out, role by role', async () => {
    const found = await granted();
    const roles = new Set([...Object.keys(STORE_GRANTS), ...Object.keys(found)]);
    for (const role of roles) {
      const declared = (STORE_GRANTS as Record<string, { on: Record<string, readonly string[]> }>)[role]?.on;
      const want = Object.fromEntries(
        Object.entries(declared ?? {}).map(([object, grants]) => [object, grants.map(normal).sort()]),
      );
      const got = Object.fromEntries(
        Object.entries(found[role] ?? {}).map(([object, grants]) => [object, grants.sort()]),
      );
      expect(got, `${role}'s grants`).toEqual(want);
    }
  });

  it('give each role the memberships the table names, and no others', async () => {
    const members = await db.owner<{ role: string; member_of: string[] }[]>`
      select r.rolname as role,
             array(select b.rolname::text from pg_auth_members m join pg_roles b on b.oid = m.roleid
                   where m.member = r.oid order by 1) as member_of
      from pg_roles r where r.rolname = any(${Object.keys(STORE_GRANTS)})`;
    expect(Object.fromEntries(members.map((m) => [m.role, m.member_of]))).toEqual(
      Object.fromEntries(
        Object.entries(STORE_GRANTS).map(([role, grants]) => [role, 'memberOf' in grants ? [...grants.memberOf] : []]),
      ),
    );
  });

  it('let every worker log in as itself, and nobody as the role they share', async () => {
    const roles = await db.owner<{ rolname: string; rolcanlogin: boolean }[]>`
      select rolname, rolcanlogin from pg_roles where rolname like 'factory\\_%' and rolname <> 'factory_writer'`;
    expect(Object.fromEntries(roles.map((r) => [r.rolname, r.rolcanlogin]))).toEqual({
      factory_worker: false,
      ...Object.fromEntries(WORKERS.map((w) => [`factory_${w}`, true])),
    });
    for (const worker of WORKERS) {
      const [me] = await db.as[worker]<{ me: string }[]>`select current_user as me`;
      expect(me?.me).toBe(`factory_${worker}`);
    }
  });
});

const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-')));
const opened = (workItem: string): NewEvent<'work-item.opened'> => ({
  id: crypto.randomUUID(),
  ts: new Date().toISOString(),
  work_item: workItem,
  type: 'work-item.opened',
  version: 2,
  actor: 'visitor',
  summary: 'A visitor sent a report',
  payload: { kind: 'visitor-report', title: 'A report', sample: true, visitor: { key: 'amber-otter' } },
  artifacts: [],
});

/** A signal from a sense, as the inbox takes it. */
const signal = (sense: 'probe' | 'crawler' | 'metrics' | 'logs' | 'canary'): InboxSignal => ({
  sense,
  check: 'home journey',
  route: '/',
  version: 'v1.0.0',
  symptom: 'server-error',
  observedAt: new Date().toISOString(),
  artifacts: [],
});

describe('each worker', () => {
  it('appends and reads events through the role they share', async () => {
    let n = 3000;
    for (const worker of WORKERS) {
      const [stored] = await new EventWriter(db.as[worker], { kind: 'sample', artifacts }).append(opened(String(++n)));
      expect(stored?.seq).toBeGreaterThan(0);
      await expect(db.as[worker]`update events set summary = 'rewritten'`).rejects.toThrow('permission denied');
    }
  });

  it('sends only its own senses’ signals to the inbox', async () => {
    const sends = { probes: 'probe', crawler: 'crawler', intake: 'metrics', logs: 'logs', line: 'canary' } as const;
    for (const [worker, sense] of Object.entries(sends)) {
      const sql = db.as[worker as keyof typeof sends];
      const id = await sendSignal(sql, signal(sense));
      // Sent again with its id, it is dropped, as a sender that cannot tell whether it sent it relies on.
      await sendSignal(sql, signal(sense), id);
      const other = sense === 'probe' ? 'crawler' : 'probe';
      await expect(sendSignal(sql, signal(other)), `${worker} sending a ${other} signal`).rejects.toThrow(
        'row-level security',
      );
    }
    await expect(sendSignal(db.as.triage, signal('probe'))).rejects.toThrow('permission denied');
    await expect(sendSignal(db.as.gateway, signal('probe'))).rejects.toThrow('permission denied');
  });

  it('leaves what triage made of a signal to triage', async () => {
    const id = await sendSignal(db.as.probes, signal('probe'));
    for (const worker of WORKERS.filter((w) => w !== 'triage')) {
      await expect(
        db.as[worker]`update inbox set outcome = 'counted', triaged_at = now() where id = ${id}`,
      ).rejects.toThrow('permission denied');
      await expect(db.as[worker]`delete from inbox where id = ${id}`).rejects.toThrow('permission denied');
    }
    // Triage deletes only the repeats it counted: row security keeps every other signal, whatever the query asks.
    expect((await db.as.triage`delete from inbox where id = ${id}`).count).toBe(0);
    await db.as.triage`update inbox set outcome = 'counted', triaged_at = now() where id = ${id}`;
    expect((await db.as.triage`delete from inbox where id = ${id}`).count).toBe(1);
  });

  it('cannot move a work item on the line, or end a job’s token, unless it is the line', async () => {
    await db.owner`insert into line (work_item, stage) values ('3100', 'plan')`;
    await db.owner`insert into job_tokens (token_sha256, job, work_item, agent)
                   values (${'a'.repeat(64)}, 'plan-3100-1', '3100', 'planner')`;
    for (const worker of WORKERS.filter((w) => w !== 'line')) {
      await expect(db.as[worker]`update line set stage = 'ended' where work_item = '3100'`).rejects.toThrow(
        'permission denied',
      );
      await expect(db.as[worker]`update job_tokens set ended_at = now() where job = 'plan-3100-1'`).rejects.toThrow(
        'permission denied',
      );
    }
    await db.as.line`update job_tokens set ended_at = now() where job = 'plan-3100-1'`;
    // Not even the line may set a row's own facts: when it was taken, or when a token was issued.
    await expect(db.as.line`update line set taken_at = now() where work_item = '3100'`).rejects.toThrow(
      'permission denied',
    );
    await expect(
      db.as.line`insert into job_tokens (token_sha256, job, work_item, agent, issued_at)
                 values (${'b'.repeat(64)}, 'plan-3100-2', '3100', 'planner', now() - interval '1 day')`,
    ).rejects.toThrow('permission denied');
  });

  it('cannot delete a picture unless it is the probes', async () => {
    for (const worker of WORKERS.filter((w) => w !== 'probes')) {
      await expect(db.as[worker]`delete from pictures`).rejects.toThrow('permission denied');
    }
    expect((await db.as.probes`delete from pictures`).count).toBe(0);
  });
});
