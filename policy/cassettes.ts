/**
 * How long the gateway keeps its cassettes where it records and replays none (`GATEWAY_MODE=record`, as on the
 * cluster): there a cassette is the record of what a call sent and got back, kept while a run might still be looked
 * into. The gateway applies it (`apps/factory/src/gateway/pruning.ts`); `model_calls`, the ledger, is never pruned.
 *
 * Human-owned: see `README.md`.
 */
export const CASSETTES = {
  /**
   * Days a cassette is kept after the last thing it was for: every work item its calls name closed, or its last call
   * when they name none, or its writing when no call names it. A file written within as many days always stays.
   */
  keepDays: 14,
  /** How often the gateway deletes the cassettes past `keepDays`, in hours. Once as it starts, too. */
  pruneHours: 6,
} as const;
