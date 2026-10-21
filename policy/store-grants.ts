/**
 * What each role may do in the event store: every table, column and sequence a role is granted, the roles whose
 * grants it holds too, and the rows that row security lets it at. The migrations make them (`packages/store/migrations`);
 * `packages/store/test/grants.test.ts` migrates a throwaway store and fails unless its grants and row security are
 * exactly these, so a grant or a policy that grows, or a role that gains one, fails until this table says so.
 *
 * Human-owned: see `README.md`.
 */

export interface RoleGrants {
  /** Who connects as it, and why it has what it has. */
  for: string;
  /** The roles whose grants it holds as well as its own. */
  memberOf?: readonly string[];
  /**
   * Its privileges on each table or sequence, by name: `select`, `insert` and the like on the whole table, or
   * `insert (a, b)` on those columns only.
   */
  on: Readonly<Record<string, readonly string[]>>;
  /**
   * On a table with row security, the rows it may reach by each command (`select`, `insert`, `update`, `delete`, or
   * `all`), as the condition a row must meet: `true` for every row. A table with row security refuses a role every row
   * it is not named for here.
   */
  rows?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** The columns a sense may give a signal: the rest are triage's, or the store's defaults. */
const SIGNAL = 'insert (id, sense, fingerprint, signal)';

export const STORE_GRANTS = {
  factory_worker: {
    for: 'Every worker, as a member: read and append events. It cannot log in.',
    on: { events: ['select', 'insert'], store: ['select', 'insert'] },
  },
  factory_triage: {
    for: 'Triage: takes each signal, records what it made of it, prunes the repeats it counted, numbers work items.',
    memberOf: ['factory_worker'],
    on: {
      inbox: ['select', 'update (attempts, not_before, failure, triaged_at, outcome, work_item)', 'delete'],
      work_items: ['usage'],
    },
    rows: { inbox: { select: 'true', update: 'true', delete: "outcome = 'counted'" } },
  },
  factory_line: {
    for: "The line: its queue, its runners' job tokens and logs, spend, and the signals it leaves triage.",
    memberOf: ['factory_worker'],
    on: {
      line: [
        'select',
        'insert (work_item, stage)',
        'update (stage, moved_at, held_by, held_until, steps, failures, failure, effects, reopened, issue, session)',
      ],
      job_tokens: ['select', 'insert (token_sha256, job, work_item, agent, traceparent)', 'update (ended_at)'],
      step_logs: ['select', 'insert (job, work_item, agent, part, pod, hash, size, ending, reason)'],
      model_calls: ['select'],
      pictures: ['select'],
      looks: ['select'],
      inbox: [SIGNAL],
    },
    rows: { inbox: { insert: "sense in ('canary', 'planner')" }, looks: { select: 'true' } },
  },
  factory_gateway: {
    for: 'The gateway: the ledger of model calls, and the job tokens it accepts.',
    memberOf: ['factory_worker'],
    on: { model_calls: ['select', 'insert'], job_tokens: ['select'] },
  },
  factory_probes: {
    for: "The probes: their signals, each release's pictures, and the looks they box on them.",
    memberOf: ['factory_worker'],
    on: {
      pictures: [
        'select',
        'insert (canary, stable, path, route, before, after, changed, diff)',
        'update (rollout)',
        'delete',
      ],
      looks: ['select', 'insert', 'update (path, elements, seen_at)'],
      inbox: ['select (signal, triaged_at)', SIGNAL],
    },
    rows: {
      inbox: { select: "(triaged_at IS NULL) AND (sense not in ('report', 'planner'))", insert: "sense = 'probe'" },
      looks: { select: 'true', insert: "sense = 'probe'", update: "sense = 'probe'" },
    },
  },
  factory_crawler: {
    for: 'The crawler: its signals, and the looks it boxes.',
    memberOf: ['factory_worker'],
    on: { looks: ['select', 'insert', 'update (path, elements, seen_at)'], inbox: [SIGNAL] },
    rows: {
      inbox: { insert: "sense = 'crawler'" },
      looks: { select: "sense = 'crawler'", insert: "sense = 'crawler'", update: "sense = 'crawler'" },
    },
  },
  factory_intake: {
    for: "The intake: the metrics' signals.",
    memberOf: ['factory_worker'],
    on: { inbox: [SIGNAL] },
    rows: { inbox: { insert: "sense = 'metrics'" } },
  },
  factory_logs: {
    for: "The log watcher: its signals and visitors' reports, and where it left off.",
    memberOf: ['factory_worker'],
    on: { inbox: ['select (sense, signal)', SIGNAL] },
    rows: { inbox: { select: "sense in ('logs', 'report')", insert: "sense in ('logs', 'report')" } },
  },
  factory_writer: {
    for: 'The make targets that write to the store, and some tests; no worker connects as it (#435).',
    on: {
      events: ['select', 'insert'],
      store: ['select', 'insert'],
      work_items: ['usage'],
      inbox: ['select', 'insert', 'update (attempts, not_before, failure, triaged_at, outcome, work_item)', 'delete'],
      model_calls: ['select', 'insert'],
      job_tokens: ['select', 'insert', 'update (ended_at)'],
      line: ['select', 'insert', 'update'],
      pictures: ['select', 'insert', 'update (rollout)', 'delete'],
      looks: ['select', 'insert', 'update'],
      step_logs: ['select', 'insert'],
    },
    rows: {
      inbox: { select: 'true', insert: 'true', update: 'true', delete: "outcome = 'counted'" },
      looks: { all: 'true' },
    },
  },
  console_reader: {
    for: "The console's server: public views of events, and the store's kind.",
    on: {
      events: ['select (seq, id, ts, work_item, type, version, actor, public, appended_at)'],
      store: ['select'],
    },
  },
  scoreboard_writer: {
    for: 'The scoreboard: reads events and appends its own figures to a real store (0012_scoreboard.sql).',
    on: { events: ['select', 'insert'], store: ['select'] },
  },
  metrics_reader: {
    for: "The Postgres exporter: the server's statistics, and nothing of the store.",
    on: {},
  },
} as const satisfies Record<string, RoleGrants>;
