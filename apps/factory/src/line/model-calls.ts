/**
 * One `model.called` for each agent's step, summed from the gateway's audit log. The gateway writes a row in
 * `model_calls` for every call, with the job that made it; a step is one job, so its calls are the rows with its
 * job's name. The event records the step; the table keeps each call.
 *
 * Calls the gateway refused never reached a model, so they are not counted. A step whose calls went to more than one
 * model is recorded under the one most of them went to, with every call's tokens and cost.
 */
import type { ModelProvider, PayloadOf } from '@software-factory/events';
import type { Sql } from 'postgres';
import type { LineAgent } from './machine.ts';

interface Row {
  provider: string;
  model: string;
  calls: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost: number;
  ms: number;
}

/** The step's calls as `model.called`'s payload, or null when it made none. */
export async function stepCalls(
  sql: Sql,
  job: string,
  agent: LineAgent,
  maxTurns: number,
): Promise<PayloadOf<'model.called'> | null> {
  const rows = await sql<Row[]>`
    select provider, model, count(*)::int as calls,
           sum(input_tokens)::int as input, sum(output_tokens)::int as output,
           sum(cache_read_tokens)::int as cache_read, sum(cache_write_tokens)::int as cache_write,
           sum(cost_usd)::float8 as cost, sum(duration_ms)::int as ms
    from model_calls
    where job = ${job} and outcome <> 'refused'
    group by provider, model
    order by count(*) desc, provider, model`;
  const [main] = rows;
  if (!main) return null;
  const sum = (field: keyof Omit<Row, 'provider' | 'model'>) => rows.reduce((total, row) => total + row[field], 0);
  return {
    agent,
    // The gateway's providers are the events' (`gateway/providers.ts`); the store checks it on append.
    provider: main.provider as ModelProvider,
    model: main.model,
    settings: { maxTurns },
    tokens: {
      input: sum('input'),
      output: sum('output'),
      cacheRead: sum('cache_read'),
      cacheWrite: sum('cache_write'),
    },
    // To a millionth of a dollar: the audit log keeps eight places, and the event needs no more than six.
    costUsd: Math.round(sum('cost') * 1e6) / 1e6,
    durationMs: sum('ms'),
    calls: sum('calls'),
  };
}
