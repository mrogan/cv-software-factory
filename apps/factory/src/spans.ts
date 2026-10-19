/**
 * The spans the factory starts itself, and the names of their attributes, so a work item can be followed through
 * the line, its runner's calls to the gateway, and the GitHub worker, in one trace.
 *
 * - The line starts a `step` span for each agent's step, `step effects` for a kept handback's effects tried again,
 *   `release` for each pass of its release watch that reads or records something of a release, and `verify` and
 *   `recheck` for each look by a sense. Its calls to the GitHub worker and the probes are made inside them, so they
 *   join the work item's trace (`instrumentations.ts`).
 * - The line keeps a step's span context with its job token (`runners/steps.ts`), and the gateway starts each
 *   `model call` span as that span's child, linked to the request that carried the call (`gateway/agents.ts`). The
 *   runner, which cannot reach the collector, needs nothing.
 *
 * The attributes are the names the gateway's metrics, its `model call` log line and the store already use, in snake
 * case: Prometheus's labels and Postgres's columns are spelt so, and a dashboard or alert reads them alike. A metric
 * takes the low-cardinality ones only (`agent`, `provider`, `model`, `outcome`); a work item or a job would make a
 * series of each.
 */
import { type Attributes, type Span, SpanStatusCode, trace } from '@opentelemetry/api';

export const ATTRIBUTES = {
  /** The work item, as the event store names it (`1001`). */
  workItem: 'work_item',
  /** The work items a release carries, or would. */
  workItems: 'work_items',
  /** The step's Kubernetes job, as its token names it (`coder-1001-1-3`). */
  job: 'job',
  /** The line's agent (`planner`, `coder`, `reviewer`, `describer`). */
  agent: 'agent',
  /** A release, as its events name it. */
  release: 'release',
  /** Whether what the span did was a dry run's (`LINE_MODE=dry-run`). */
  dryRun: 'dry_run',
  /**
   * How it ended. A step: `finished`, `max-turns`, `failed` or `stopped`. A look: `cleared`, `persists`, `unsure`,
   * `wait` or `hold`. A model call: `answered`, `replayed`, `refused` or `failed`, as `gateway_calls_total` counts it.
   */
  outcome: 'outcome',
  /** Why a model call was refused or failed. */
  reason: 'reason',
  /** Where the gateway sent a call: `anthropic` or `local`. */
  provider: 'provider',
  /** The model policy chose for the call, whatever the runner asked for. */
  model: 'model',
  inputTokens: 'input_tokens',
  outputTokens: 'output_tokens',
  cacheReadTokens: 'cache_read_tokens',
  cacheWriteTokens: 'cache_write_tokens',
  /** What the call cost, in US dollars: nothing for a replay. */
  costUsd: 'cost_usd',
} as const;

export const tracer = trace.getTracer('@software-factory/factory');

/**
 * Runs `work` inside a new span, as the active one, so what it calls is the span's children. A throw marks the span an
 * error; the span ends when `work` does.
 */
export function inSpan<T>(name: string, attributes: Attributes, work: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error)?.message });
      throw error;
    } finally {
      span.end();
    }
  });
}
