/**
 * Agents' calls: the gateway's Messages API, `POST /v1/messages` in Anthropic's own shape, streaming included, for
 * runners. A runner's Agent SDK points `ANTHROPIC_BASE_URL` here, with its job token where an API key would go.
 *
 * For each call the gateway:
 *
 * 1. Takes the job token (`x-api-key`, or `Authorization: Bearer`) and finds the job it was made for, while the job
 *    has not ended: that names the work item and the agent. It refuses every call while the line is stopped.
 * 2. Sends the call where policy says (`policy/models.ts`): the provider, the pinned model and the effort, whatever
 *    the runner asked for.
 * 3. Answers from a cassette, keyed as `agent-cassettes.ts` says, when its mode replays; otherwise checks the spend
 *    caps, asks the provider, relays the answer as it arrives, and records a cassette.
 * 4. Writes one audit row in `model_calls` for every call, answered or not, with its tokens, cache use and cost.
 *
 * Prompt caching passes through untouched: the runner's `cache_control` markers reach the provider as sent.
 *
 * Errors keep Anthropic's shape (`{ type: "error", error: { type, message } }`), so the Agent SDK reads them as it
 * would Anthropic's: it retries a 429 after `retry-after`, and gives up on a 4xx.
 */

import { jobForToken } from '@software-factory/store';
import type { Sql } from 'postgres';
import { MODEL_AGENTS, type ModelAgent, modelFor } from '../../../../policy/models.ts';
import type { Profile } from '../../../../policy/spend.ts';
import type { Logger } from '../log.ts';
import { type AgentCassettes, agentCassetteKey, keyedRequest } from './agent-cassettes.ts';
import { SpendCapped } from './errors.ts';
import type { Mode } from './gateway.ts';
import * as instruments from './metrics.ts';
import { costOf, priceOf, type Usage } from './prices.ts';
import type { ProviderCaps } from './provider-caps.ts';
import { capOf, forwardedHeaders, type MessagesProvider, type ProviderName } from './providers.ts';
import type { Spend } from './spend.ts';

export interface Reply {
  status: number;
  headers: Record<string, string>;
  /** A whole body, or a stream relayed chunk by chunk. */
  body: string | AsyncIterable<Uint8Array>;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Reply => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

/** An error in Anthropic's shape. Its message never holds the request. */
export const apiError = (status: number, type: string, message: string, headers: Record<string, string> = {}) =>
  json(status, { type: 'error', error: { type, message } }, headers);

export interface AgentCallsOptions {
  sql: Sql;
  spend: Spend;
  caps: ProviderCaps;
  cassettes: AgentCassettes;
  /** What was asked for. A provider the gateway has no way to reach is replayed only. */
  mode: Mode;
  profile: Profile;
  /** Every agent to the profile's local model. */
  allLocal: boolean;
  providers: Partial<Record<ProviderName, MessagesProvider>>;
  log: Logger;
  clock?: () => Date;
}

type Headers = Record<string, string | string[] | undefined>;

interface Call {
  job: string;
  workItem: string;
  agent: ModelAgent;
  provider: ProviderName;
  model: string;
}

type Outcome = 'answered' | 'replayed' | 'refused' | 'failed';

/** How long the line's state is trusted before it is read again. */
const LINE_FRESH_MS = 5_000;

export class AgentCalls {
  readonly #o: AgentCallsOptions;
  #line: { stopped: boolean; at: number } | undefined;

  constructor(options: AgentCallsOptions) {
    this.#o = options;
  }

  async messages(headers: Headers, text: string): Promise<Reply> {
    const started = performance.now();
    const who = await this.#authorise(headers);
    if ('status' in who) return who;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error();
    } catch {
      return apiError(400, 'invalid_request_error', 'The body is not a JSON object.');
    }
    const chosen = modelFor(this.#o.profile, who.agent, this.#o.allLocal);
    const provider = chosen.provider === 'local' ? 'local' : 'anthropic';
    const call: Call = { ...who, provider, model: chosen.model };
    priceOf(chosen.model);
    // The policy's model and effort, whatever the runner asked for.
    const outputConfig = (body.output_config ?? {}) as Record<string, unknown>;
    const sent: Record<string, unknown> = {
      ...body,
      model: chosen.model,
      output_config: { ...outputConfig, effort: chosen.effort },
    };
    const stream = sent.stream === true;
    const keyed = keyedRequest(sent);
    const key = agentCassetteKey(provider, keyed);
    const { cassettes, spend, caps, mode, providers, log } = this.#o;
    const audit = (outcome: Outcome, usage: Usage = { inputTokens: 0, outputTokens: 0 }, reason?: string) =>
      this.#audit(call, key, outcome, usage, performance.now() - started, reason);

    const replaying = mode === 'replay' || mode === 'replay-record';
    const stored = replaying ? cassettes.find(key) : undefined;
    if (stored) {
      await audit('replayed', usageOf(stored.response, stored.stream));
      return { status: 200, headers: { 'content-type': contentType(stored.stream) }, body: stored.response };
    }
    const target = providers[provider];
    if (mode === 'replay' || !target) {
      await audit('refused', undefined, 'no cassette');
      return apiError(
        400,
        'invalid_request_error',
        `No cassette ${key} holds this call, and the gateway may only replay ${provider}.`,
      );
    }
    const held = caps.heldFor(provider);
    if (held) {
      await audit('refused', undefined, held.reason);
      return apiError(429, 'rate_limit_error', `${provider} refuses calls for now (${held.reason}): ${held.message}`, {
        'retry-after': '300',
      });
    }
    try {
      await spend.check(call.workItem);
    } catch (error) {
      if (!(error instanceof SpendCapped)) throw error;
      await audit('refused', undefined, error.message);
      // A day's or month's cap resets; a work item's does not, and holds the work item for Martin.
      return error.resets
        ? apiError(429, 'rate_limit_error', error.message, {
            'retry-after': String(Math.max(1, Math.ceil((Date.parse(error.resets) - Date.now()) / 1000))),
          })
        : apiError(403, 'permission_error', error.message);
    }

    let response: Response;
    try {
      response = await target.send('/v1/messages', JSON.stringify(sent), forwardedHeaders(headers));
    } catch (error) {
      const message = `${provider} could not be reached (${causeOf(error)})`.slice(0, 300);
      await audit('failed', undefined, message);
      // Nothing listening on the local model is a cap: it waits for Martin to start LM Studio.
      if (provider === 'local') await caps.cap('local', { reason: 'unreachable', message });
      return apiError(
        provider === 'local' ? 429 : 502,
        provider === 'local' ? 'rate_limit_error' : 'api_error',
        message,
      );
    }
    if (!response.ok) {
      const errorBody = await response.text();
      const cap = capOf(response.status, errorBody);
      await audit('failed', undefined, `${provider} answered ${response.status}`);
      if (cap) {
        await caps.cap(provider, cap);
        return apiError(429, 'rate_limit_error', `${provider} refuses calls for now (${cap.reason}): ${cap.message}`, {
          'retry-after': '300',
        });
      }
      // Anything else is the provider's to say: a rate limit, an overload, a request it will not take.
      const retryAfter = response.headers.get('retry-after');
      return {
        status: response.status,
        headers: { 'content-type': 'application/json', ...(retryAfter ? { 'retry-after': retryAfter } : {}) },
        body: errorBody,
      };
    }
    void caps.clear(provider);

    const finish = async (raw: string) => {
      const usage = usageOf(raw, stream);
      await audit('answered', usage);
      await spend.reconcile();
      if (mode !== 'live') {
        try {
          cassettes.record({
            key,
            kind: 'messages',
            provider,
            model: chosen.model,
            recordedAt: (this.#o.clock?.() ?? new Date()).toISOString(),
            request: keyed,
            stream,
            response: raw,
          });
        } catch (error) {
          log.warn(
            { cassette: key, reason: (error as NodeJS.ErrnoException).code ?? 'unknown' },
            'the cassette could not be written',
          );
        }
      }
    };
    if (!stream || !response.body) {
      const raw = await response.text();
      await finish(raw);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: raw };
    }
    return {
      status: 200,
      headers: { 'content-type': contentType(true) },
      body: relay(response.body, finish, () => audit('failed', undefined, 'the stream broke off')),
    };
  }

  /** Token counting, for the Agent SDK's budgeting: the provider's own count where there is one, an estimate where not. */
  async countTokens(headers: Headers, text: string): Promise<Reply> {
    const who = await this.#authorise(headers);
    if ('status' in who) return who;
    const chosen = modelFor(this.#o.profile, who.agent, this.#o.allLocal);
    const anthropic = this.#o.providers.anthropic;
    if (chosen.provider !== 'local' && anthropic && this.#o.mode !== 'replay') {
      try {
        const body = { ...JSON.parse(text), model: chosen.model };
        const response = await anthropic.send(
          '/v1/messages/count_tokens',
          JSON.stringify(body),
          forwardedHeaders(headers),
        );
        if (response.ok) return json(200, await response.json());
      } catch {
        // An estimate will do.
      }
    }
    // About four characters a token: enough for a budget, and the same on every replay.
    return json(200, { input_tokens: Math.ceil(text.length / 4) });
  }

  async #authorise(headers: Headers): Promise<Pick<Call, 'job' | 'workItem' | 'agent'> | Reply> {
    const header = (name: string) => {
      const value = headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const token = header('x-api-key') ?? header('authorization')?.replace(/^Bearer\s+/i, '');
    const job = token ? await jobForToken(this.#o.sql, token) : undefined;
    if (!job) return apiError(401, 'authentication_error', 'This is not the token of a job that is running.');
    if (!(MODEL_AGENTS as readonly string[]).includes(job.agent)) {
      return apiError(403, 'permission_error', `The ${job.agent} agent does not call models through this API.`);
    }
    if (await this.#lineStopped()) {
      return apiError(403, 'permission_error', 'The line is stopped: agents take no new calls until it starts again.');
    }
    return { job: job.job, workItem: job.workItem, agent: job.agent as ModelAgent };
  }

  async #lineStopped(): Promise<boolean> {
    const now = Date.now();
    if (this.#line && now - this.#line.at < LINE_FRESH_MS) return this.#line.stopped;
    const [last] = await this.#o.sql<{ type: string }[]>`
      select type from events where type in ('line.stopped', 'line.started') order by seq desc limit 1`;
    this.#line = { stopped: last?.type === 'line.stopped', at: now };
    return this.#line.stopped;
  }

  async #audit(call: Call, key: string, outcome: Outcome, usage: Usage, ms: number, reason?: string): Promise<void> {
    const { sql, log } = this.#o;
    const costUsd = outcome === 'answered' ? costOf(call.model, usage) : 0;
    const durationMs = Math.round(ms);
    const cacheWrite = (usage.cacheWriteTokens ?? 0) + (usage.cacheWriteHourTokens ?? 0);
    await sql`
      insert into model_calls (id, at, agent, work_item, provider, model, question_set, input_tokens, output_tokens,
                               cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, cassette, outcome, job)
      values (${crypto.randomUUID()}, ${(this.#o.clock?.() ?? new Date()).toISOString()}::timestamptz, ${call.agent},
              ${call.workItem}, ${call.provider}, ${call.model}, 'messages', ${usage.inputTokens}, ${usage.outputTokens},
              ${usage.cacheReadTokens ?? 0}, ${cacheWrite}, ${costUsd}, ${durationMs}, ${key}, ${outcome}, ${call.job})`;
    const attributes = { agent: call.agent, provider: call.provider, model: call.model, outcome };
    instruments.calls.add(1, attributes);
    instruments.latency.record(durationMs, attributes);
    if (costUsd > 0) instruments.spend.add(costUsd, { agent: call.agent, provider: call.provider, model: call.model });
    const level = outcome === 'failed' ? 'error' : outcome === 'refused' ? 'warn' : 'info';
    log[level](
      { ...call, ...usage, costUsd, durationMs, cassette: key, outcome, ...(reason ? { reason } : {}) },
      'model call',
    );
  }
}

/** Why a fetch failed: Node puts the network's reason, such as ECONNREFUSED, in the error's cause. */
const causeOf = (error: unknown) => {
  const cause = (error as Error)?.cause as (Error & { code?: string }) | undefined;
  return cause?.code ?? cause?.message ?? (error as Error)?.message ?? 'unknown';
};

const contentType = (stream: boolean) => (stream ? 'text/event-stream; charset=utf-8' : 'application/json');

/**
 * Relays a stream to the runner as it arrives, keeping a copy; when it ends whole, `done` gets the copy. A stream
 * that breaks off, or that the runner leaves, is recorded as failed and keeps no cassette.
 */
async function* relay(
  stream: ReadableStream<Uint8Array>,
  done: (raw: string) => Promise<void>,
  broke: () => Promise<void>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let whole = false;
  try {
    for (;;) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      raw += decoder.decode(value, { stream: true });
      yield value;
    }
    raw += decoder.decode();
    // A stream that reports an error part-way is not a response to keep.
    whole = !/^event: error$/m.test(raw);
  } finally {
    if (whole) await done(raw);
    else {
      await reader.cancel().catch(() => {});
      await broke();
    }
  }
}

interface ApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

/**
 * A response's usage, from its JSON or from its stream's events: `message_start` carries the input and the cache,
 * and each `message_delta` the output so far.
 */
export function usageOf(raw: string, stream: boolean): Usage {
  let usage: ApiUsage = {};
  if (!stream) usage = (JSON.parse(raw) as { usage?: ApiUsage }).usage ?? {};
  else {
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const data = JSON.parse(line.slice(5)) as { type?: string; message?: { usage?: ApiUsage }; usage?: ApiUsage };
        if (data.type === 'message_start') usage = { ...usage, ...data.message?.usage };
        if (data.type === 'message_delta') usage = { ...usage, ...data.usage };
      } catch {
        // Not every data line is JSON a usage is in.
      }
    }
  }
  const hour = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: (usage.cache_creation_input_tokens ?? 0) - hour,
    cacheWriteHourTokens: hour,
  };
}
