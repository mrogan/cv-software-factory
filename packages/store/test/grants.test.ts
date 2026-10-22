/**
 * The store's grants are exactly those `policy/store-grants.ts` sets out: a grant that grows, a role that gains one or
 * a membership that changes fails here until the table says so. Then what each worker's role may and may not do, as
 * the worker would try it; that only Martin's roles append his commands; and the tables of signing in.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMIN_TYPES, EVENT_TYPES, type EventType, type InboxSignal, type NewEvent } from '@software-factory/events';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENROLMENT_CODE, PASSKEYS, SESSION } from '../../../policy/access.ts';
import { MARTINS_ROLES, STORE_GRANTS } from '../../../policy/store-grants.ts';
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

  it('let each role at only the rows the table names, on the tables with row security', async () => {
    const policies = await db.owner<
      { table: string; command: string; roles: string[]; using: string; check: string }[]
    >`
      select tablename as table, lower(cmd) as command, roles::text[] as roles, qual as using, with_check as check
      from pg_policies where schemaname = 'public'`;
    // As Postgres prints a condition, and as the table writes it: no casts to text, `in` for `= any (array[...])` and
    // `not in` for `<> all (array[...])`.
    const condition = (printed: string | null) =>
      printed
        ?.replaceAll(/::text(\[\])?/g, '')
        .replaceAll(/(\w+) = ANY \(ARRAY\[(.+?)\]\)/g, '$1 in ($2)')
        .replaceAll(/(\w+) <> ALL \(ARRAY\[(.+?)\]\)/g, '$1 not in ($2)')
        .replace(/^\((.*)\)$/, '$1');
    const found: Record<string, Record<string, Record<string, string>>> = {};
    for (const policy of policies) {
      const using = condition(policy.using);
      const check = condition(policy.check);
      const rows = using && check && using !== check ? `using ${using}, check ${check}` : (using ?? check ?? '');
      for (const role of policy.roles) {
        found[role] ??= {};
        const tables = found[role] as Record<string, Record<string, string>>;
        tables[policy.table] ??= {};
        const commands = tables[policy.table] as Record<string, string>;
        expect(
          commands[policy.command],
          `${role} has two policies for ${policy.command} on ${policy.table}`,
        ).toBeUndefined();
        commands[policy.command] = rows;
      }
    }
    const declared = Object.fromEntries(
      Object.entries(STORE_GRANTS as Record<string, { rows?: Record<string, Record<string, string>> }>).flatMap(
        ([role, grants]) => (grants.rows ? [[role, grants.rows]] : []),
      ),
    );
    expect(found).toEqual(declared);

    // Row security is on wherever the table names rows, and nowhere else, so none can be switched off unseen.
    const secured = await db.owner<{ relname: string }[]>`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relrowsecurity order by 1`;
    expect(secured.map((t) => t.relname)).toEqual(
      [...new Set(Object.values(declared).flatMap((tables) => Object.keys(tables)))].sort(),
    );
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

  it('let every worker log in as itself, and nobody as the role they share or as the writer', async () => {
    const roles = await db.owner<{ rolname: string; rolcanlogin: boolean }[]>`
      select rolname, rolcanlogin from pg_roles where rolname like 'factory\\_%'`;
    // 0024 drops the writer, or, where another database on the server still grants it something, leaves it there
    // unable to log in; the grants above show it holds nothing here.
    const { factory_writer: writer, ...rest } = Object.fromEntries(roles.map((r) => [r.rolname, r.rolcanlogin]));
    expect(writer ?? false).toBe(false);
    expect(rest).toEqual({
      factory_worker: false,
      ...Object.fromEntries(WORKERS.map((w) => [`factory_${w}`, true])),
      factory_admin: true,
      factory_operator: true,
      factory_enrol: true,
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
  it('has its signals kept by id alone: the inbox has no other unique key', async () => {
    // sendSignal's `on conflict do nothing` names no key, so that a sense needs no right to read the inbox; this
    // keeps it from swallowing a conflict on any other.
    const unique = await db.owner<{ name: string }[]>`
      select indexrelid::regclass::text as name from pg_index where indrelid = 'inbox'::regclass and indisunique`;
    expect(unique.map((i) => i.name)).toEqual(['inbox_pkey']);
  });

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

  it('keeps only its own sense’s looks, and reads only the signals it needs', async () => {
    const look = (sense: string) =>
      db.owner.json({ sense, check: 'home journey', route: '/', path: '/', elements: [] });
    await db.owner`insert into looks (sense, "check", route, path, elements, seen_at)
                   values ('probe', 'home journey', '/', '/', ${look('probe')}, now())`;
    await expect(
      db.as.crawler`insert into looks (sense, "check", route, path, elements, seen_at)
                    values ('probe', 'other', '/', '/', '[]', now())`,
    ).rejects.toThrow('row-level security');
    expect((await db.as.crawler`update looks set path = '/elsewhere' where sense = 'probe'`).count).toBe(0);
    expect(await db.as.crawler`select path from looks where sense = 'probe'`).toEqual([]);
    expect(await db.as.probes`select path from looks where sense = 'probe'`).toEqual([{ path: '/' }]);
    // A visitor's report is read by triage alone, waiting or not, and a counted signal by neither the probes nor the
    // log watcher.
    const report = await sendSignal(db.as.logs, {
      sense: 'report',
      check: 'report widget',
      route: '/',
      version: 'v1.0.0',
      observedAt: new Date().toISOString(),
      report: { page: '/', text: 'The lid is missing' },
      artifacts: [],
    });
    expect(await db.as.probes`select signal from inbox where signal->>'sense' = 'report'`).toEqual([]);
    await db.as.triage`update inbox set outcome = 'counted', triaged_at = now() where id = ${report}`;
    expect(await db.as.probes`select signal from inbox where triaged_at is not null`).toEqual([]);
    expect((await db.as.logs`select sense from inbox`).every((r) => ['logs', 'report'].includes(r.sense))).toBe(true);
  });

  it('cannot delete a picture unless it is the probes', async () => {
    for (const worker of WORKERS.filter((w) => w !== 'probes')) {
      await expect(db.as[worker]`delete from pictures`).rejects.toThrow('permission denied');
    }
    expect((await db.as.probes`delete from pictures`).count).toBe(0);
  });
});

/** One of Martin's commands, as `actor: martin`. A command added to ADMIN_TYPES needs its payload here. */
const command = (type: EventType, workItem: string | null = null): NewEvent =>
  ({
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    work_item: type === 'hold.answered' ? workItem : null,
    type,
    version: 1,
    actor: 'martin',
    summary: `${type}, as Martin`,
    payload:
      type === 'hold.answered'
        ? { decision: 'approved' }
        : type === 'line.stopped'
          ? { reason: 'Martin stopped the line' }
          : { autonomy: 'supervised' },
    artifacts: [],
  }) as NewEvent;

const writer = (sql: Sql) => new EventWriter(sql, { kind: 'sample', artifacts });

describe("Martin's commands", () => {
  it('are the same types to the store as to the factory', async () => {
    const rows = await db.owner<{ type: string }[]>`
      select type from unnest(${[...EVENT_TYPES, 'passkey.enrolled']}::text[]) as type where admin_event(type)`;
    expect(rows.map((r) => r.type).sort()).toEqual([...ADMIN_TYPES].sort());
  });

  it('are refused from every worker’s role and the scoreboard’s', async () => {
    await writer(db.operator).append(opened('3200'));
    for (const type of ADMIN_TYPES) {
      for (const [name, sql] of [...Object.entries(db.as), ['scoreboard', db.scoreboard]]) {
        // The scoreboard's own trigger (0012) refuses it first.
        await expect(writer(sql as Sql).append(command(type, '3200')), `${type} from ${name}`).rejects.toThrow(
          /row-level security|the scoreboard appends its own figures/,
        );
      }
    }
    expect(await db.owner`select 1 from events where type in ${db.owner(ADMIN_TYPES)}`).toEqual([]);
    // Were the guard to fail, the console would still not show one.
    await db.owner`alter table events disable row level security`;
    try {
      await writer(db.as.line).append(command('line.stopped'));
    } finally {
      await db.owner`alter table events enable row level security`;
    }
    expect(await db.owner`select 1 from events where type = 'line.stopped'`).toHaveLength(1);
    expect(await db.reader`select seq from events where type = 'line.stopped'`).toEqual([]);
    await writer(db.admin).append(command('line.started'));
    expect(await db.reader`select seq from events where type = 'line.started'`).toHaveLength(1);
  });

  it('are appended by Martin’s roles alone: the admin service nothing else, his command line anything', async () => {
    await writer(db.admin).append(command('hold.answered', '3200'));
    await writer(db.admin).append(command('line.stopped'));
    await writer(db.operator).append(command('line.started'));
    await expect(writer(db.admin).append(opened('3201'))).rejects.toThrow('row-level security');
    await writer(db.operator).append(opened('3201'));
    expect(MARTINS_ROLES.sort()).toEqual(['factory_admin', 'factory_operator']);
  });

  it('carry the role that appended them, which the store sets and no client may', async () => {
    const [mine] = await writer(db.as.line).append(opened('3202'));
    const [answer] = await writer(db.admin).append(command('hold.answered', '3202'));
    const stamped = await db.owner<{ seq: string; appended_by: string }[]>`
      select seq, appended_by from events where seq in ${db.owner([mine?.seq ?? 0, answer?.seq ?? 0])} order by seq`;
    expect(stamped.map((row) => row.appended_by)).toEqual(['factory_line', 'factory_admin']);
    const insert = (sql: Sql, as: string | null) => sql`
      insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample,
                          appended_by)
      values (${crypto.randomUUID()}, now(), '3202', 'work-item.summarised', 1, 'planner', 'A summary', '{}', '[]',
              '{}', true, ${as})`;
    await expect(insert(db.as.line, 'factory_admin')).rejects.toThrow('records the role that appends an event');
    await expect(insert(db.as.line, null)).rejects.toThrow('records the role that appends an event');
    await expect(insert(db.owner, 'factory_admin')).rejects.toThrow('records the role that appends an event');
    // Nor may a worker take one of Martin's roles.
    await expect(db.as.line`set role factory_admin`).rejects.toThrow('permission denied');
    // The console's server does not see who appended an event.
    await expect(db.reader`select appended_by from events`).rejects.toThrow('permission denied');
  });
});

describe('signing in', () => {
  const hex = (n: number) => n.toString(16).padStart(64, '0');
  const key = (n: number) => `credential-${String(n).padStart(8, '0')}`;
  let codes = 0;
  /** A code from `factory admin enrol`, and a passkey the admin service enrols with it. */
  const enrolled = async (n: number) => {
    const code = hex(++codes);
    await db.enrol`insert into enrolment_codes (code_sha256) values (${code})`;
    await db.admin`update enrolment_codes set used_at = now() where code_sha256 = ${code}`;
    await db.admin`insert into passkeys (id, public_key, name, enrolled_with)
                   values (${key(n)}, '\\x00', ${`Device ${n}`}, ${code})`;
  };

  it('gives no worker, the console or the scoreboard anything of it', async () => {
    for (const [name, sql] of [
      ...Object.entries(db.as),
      ['console', db.reader],
      ['scoreboard', db.scoreboard],
      ['operator', db.operator],
    ]) {
      for (const table of ['passkeys', 'enrolment_codes', 'sessions', 'webauthn_challenges']) {
        await expect((sql as Sql)`select * from ${db.owner(table)}`, `${name} reading ${table}`).rejects.toThrow(
          'permission denied',
        );
      }
    }
  });

  it('lets the enrolment add a code and revoke, and nothing more', async () => {
    await expect(
      db.enrol`insert into enrolment_codes (code_sha256, expires_at) values (${hex(900)}, now() + interval '1 day')`,
    ).rejects.toThrow('permission denied');
    await expect(db.enrol`select code_sha256 from enrolment_codes`).rejects.toThrow('permission denied');
    await expect(db.enrol`select public_key from passkeys`).rejects.toThrow('permission denied');
    await expect(db.enrol`update sessions set expires_at = now() + interval '1 day'`).rejects.toThrow(
      'permission denied',
    );
    await expect(writer(db.enrol).append(opened('3300'))).rejects.toThrow('permission denied');
  });

  it('holds a code to the policy’s ten minutes and five tries, used once', async () => {
    const code = hex(++codes);
    await db.enrol`insert into enrolment_codes (code_sha256) values (${code})`;
    const [row] = await db.admin<{ minutes: number }[]>`
      select extract(epoch from expires_at - created_at) / 60 as minutes from enrolment_codes where code_sha256 = ${code}`;
    expect(Number(row?.minutes)).toBe(ENROLMENT_CODE.minutes);
    for (let i = 0; i < ENROLMENT_CODE.tries; i++) {
      await db.admin`update enrolment_codes set tries = tries + 1 where code_sha256 = ${code}`;
    }
    await expect(db.admin`update enrolment_codes set tries = tries + 1 where code_sha256 = ${code}`).rejects.toThrow(
      'check constraint',
    );
    await db.admin`update enrolment_codes set used_at = now() where code_sha256 = ${code}`;
    await expect(db.admin`update enrolment_codes set used_at = now() where code_sha256 = ${code}`).rejects.toThrow(
      'used once',
    );
  });

  it('holds Martin to two passkeys, and a session to eight hours, ended when its passkey is revoked', async () => {
    expect(PASSKEYS.most).toBe(2);
    expect(SESSION.hours).toBe(8);
    await enrolled(1);
    await enrolled(2);
    await expect(enrolled(3)).rejects.toThrow('two passkeys already');
    const session = hex(500);
    // The store sets a session's eight hours from its own clock: the admin service cannot set either end.
    await expect(
      db.admin`insert into sessions (id_sha256, passkey, expires_at)
               values (${session}, ${key(1)}, now() + interval '1 day')`,
    ).rejects.toThrow('permission denied');
    await expect(
      db.admin`insert into sessions (id_sha256, passkey, signed_in_at)
               values (${session}, ${key(1)}, now() - interval '1 day')`,
    ).rejects.toThrow('permission denied');
    await db.admin`insert into sessions (id_sha256, passkey) values (${session}, ${key(1)})`;
    const [lasts] = await db.admin<{ hours: number }[]>`
      select extract(epoch from expires_at - signed_in_at) / 3600 as hours from sessions where id_sha256 = ${session}`;
    expect(Number(lasts?.hours)).toBe(SESSION.hours);
    // `factory admin enrol --revoke-others` revokes, and the store ends the passkey's sessions with it.
    await db.enrol`update passkeys set revoked_at = now() where id = ${key(1)}`;
    const [ended] = await db.admin<{ ended_by: string }[]>`select ended_by from sessions where id_sha256 = ${session}`;
    expect(ended?.ended_by).toBe('revoked');
    await expect(db.admin`update passkeys set revoked_at = null where id = ${key(1)}`).rejects.toThrow('stays revoked');
    await expect(
      db.admin`update sessions set ended_at = null, ended_by = null where id_sha256 = ${session}`,
    ).rejects.toThrow('stays ended');
    await enrolled(3);
  });

  it('uses each WebAuthn challenge once', async () => {
    const challenge = 'c'.repeat(43);
    await db.admin`insert into webauthn_challenges (challenge, purpose, expires_at)
                   values (${challenge}, 'sign-in', now() + interval '5 minutes')`;
    await db.admin`update webauthn_challenges set used_at = now() where challenge = ${challenge}`;
    await expect(
      db.admin`update webauthn_challenges set used_at = now() where challenge = ${challenge}`,
    ).rejects.toThrow('used once');
    await expect(
      db.admin`insert into webauthn_challenges (challenge, purpose, expires_at)
               values (${'d'.repeat(43)}, 'step-up', now() + interval '5 minutes')`,
    ).rejects.toThrow('check constraint');
  });
});
