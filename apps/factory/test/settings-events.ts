/**
 * Martin's settings for the tests: a valid `settings.changed`, and one appended straight to the store, unchecked, as
 * whichever role is given. Row security lets one of his roles append it, so only the readers' own check stands between
 * an event outside policy and what is in force.
 */
import type { Sql } from 'postgres';

/** Every setting as policy's defaults have them on `local`, with any given on top. */
export function settingsPayload(
  over: { agents?: Record<string, unknown>; caps?: Record<string, unknown>; changes?: unknown[] } = {},
) {
  return {
    agents: {
      planner: { model: 'claude-sonnet-5-5', effort: 'medium' },
      coder: { model: 'claude-sonnet-5-5', effort: 'medium' },
      reviewer: { model: 'claude-sonnet-5-5', effort: 'medium' },
      describer: { model: 'claude-sonnet-5-5', effort: 'low' },
      ...over.agents,
    },
    caps: { dayUsd: 20, monthUsd: null, workItemUsd: 1, ...over.caps },
    changes: over.changes ?? [{ field: 'cap', cap: 'day', beforeUsd: 20, afterUsd: 20 }],
  };
}

/** Appends a settings event as `sql`'s role, straight into `events`, with no check of its payload. */
export async function appendSettings(sql: Sql, payload: unknown): Promise<void> {
  await sql`
    insert into events (id, ts, type, version, actor, summary, payload, artifacts, public, sample)
    values (${crypto.randomUUID()}, now(), 'settings.changed', 1, 'martin', 'Martin changed the settings',
            ${sql.json(payload as never)}, '[]', '{}', false)`;
}
