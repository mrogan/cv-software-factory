/**
 * What a runner's pods printed, kept with the step (migration 0017). The line deletes a step's Jobs as the step ends,
 * and their pods with them, so before it does it reads each pod's log through the Kubernetes API and keeps it here:
 * the text in the artifact store, and its index in Postgres, by job, work item and how the step ended. It is the one
 * record of why a step failed that outlives its pods.
 *
 * No event names a log, so the console serves none: what a pod printed is the runner's own words, not a public view.
 * `factory line logs <work item>` prints a work item's, in the line's pod, which mounts the artifact store.
 */
import type { Readable } from 'node:stream';
import type { ArtifactStore } from '@software-factory/store';
import type { Sql } from 'postgres';

export type StepEnding = 'handed-back' | 'failed' | 'stopped' | 'errored';

export interface StepLog {
  job: string;
  workItem: string;
  agent: string;
  part: 'prepare' | 'agent';
  pod: string;
  ending: StepEnding;
  /** Why the step failed, or why the line could not run it. */
  reason: string | null;
}

export interface KeptLog extends StepLog {
  hash: string;
  size: number;
  keptAt: Date;
}

interface Row {
  job: string;
  work_item: string;
  agent: string;
  part: 'prepare' | 'agent';
  pod: string;
  ending: StepEnding;
  reason: string | null;
  hash: string;
  size: number;
  kept_at: Date;
}

export class StepLogs {
  readonly #sql: Sql;
  readonly #artifacts: ArtifactStore;

  constructor(sql: Sql, artifacts: ArtifactStore) {
    this.#sql = sql;
    this.#artifacts = artifacts;
  }

  /** Keeps one pod's log. A pod's log is kept once: the first time is the record. */
  async keep(log: StepLog, text: string): Promise<void> {
    const bytes = new TextEncoder().encode(text);
    const hash = await this.#artifacts.put(bytes);
    await this.#sql`
      insert into step_logs (job, work_item, agent, part, pod, hash, size, ending, reason)
      values (${log.job}, ${log.workItem}, ${log.agent}, ${log.part}, ${log.pod}, ${hash}, ${bytes.byteLength},
              ${log.ending}, ${log.reason})
      on conflict (job, pod) do nothing`;
  }

  /** A work item's kept logs, in the order they were kept. */
  async of(workItem: string): Promise<KeptLog[]> {
    const rows = await this.#sql<Row[]>`
      select job, work_item, agent, part, pod, ending, reason, hash, size, kept_at
      from step_logs where work_item = ${workItem} order by kept_at, pod`;
    return rows.map((row) => ({
      job: row.job,
      workItem: row.work_item,
      agent: row.agent,
      part: row.part,
      pod: row.pod,
      ending: row.ending,
      reason: row.reason,
      hash: row.hash,
      size: row.size,
      keptAt: row.kept_at,
    }));
  }

  /** A kept log's text, or null if the artifact store has lost it. */
  open(hash: string): Promise<Readable | null> {
    return this.#artifacts.open(hash);
  }
}
