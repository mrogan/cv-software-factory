/**
 * Agents' calls: the gateway's Messages API, `POST /v1/messages` in Anthropic's own shape, streaming included, for
 * runners. A runner's Agent SDK points `ANTHROPIC_BASE_URL` here, with its job token where an API key would go.
 *
 * For each call the gateway:
 *
 * 1. Takes the job token (`x-api-key`, or `Authorization: Bearer`) and finds the job it was made for, while the job
 *    has not ended: that names the work item and the agent. It refuses every call while the line is stopped. Only
 *    then does it read the body.
 * 2. Takes only what it knows: the request's fields, its betas and its tools are allow-listed (`REQUEST`, `BETAS`).
 *    A server tool, such as web search, would let a fenced agent reach the web through the gateway and would cost
 *    what the caps do not count, so only the runner's own tools are allowed.
 * 3. Sends the call where policy says (`policy/models.ts`): the provider, the pinned model and, for Claude, the
 *    effort, whatever the runner asked for. The local model is sent no effort: LM Studio's own setting decides it.
 * 4. Answers from a cassette, keyed as `agent-cassettes.ts` says, when its mode replays; otherwise checks the spend
 *    caps, asks the provider, relays the answer as it arrives, and records a cassette.
 * 5. Writes one audit row in `model_calls` for every call, answered or not, with its tokens, cache use and cost. A
 *    stream that breaks off is audited at what it had cost by then: the provider bills what it generated.
 *
 * Prompt caching passes through untouched: the runner's `cache_control` markers reach the provider as sent.
 *
 * Errors keep Anthropic's shape (`{ type: "error", error: { type, message } }`), so the Agent SDK reads them as it
 * would Anthropic's: it retries a 429 after `retry-after`, and gives up on a 4xx.
 */

import { jobForToken } from '@software-factory/store';
import type { Sql } from 'postgres';
import { z } from 'zod';
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

/**
 * The betas a runner may send: those the pinned Agent SDK sends. One it adds after an upgrade is refused until it is
 * added here, after a look at what it does.
 */
export const BETAS = new Set([
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'mid-conversation-system-2026-04-07',
  'per-turn-control-2026-07-01',
  'mid-conversation-tool-changes-2026-07-01',
  'effort-2025-11-24',
  'thinking-display-updates-2026-08-18',
]);

/** A tool the runner runs itself. A server tool has a `type` (`web_search_…`, `code_execution_…`), and is refused. */
const clientTool = z.looseObject({
  name: z.string().min(1).max(128),
  input_schema: z.record(z.string(), z.unknown()),
  type: z.literal('custom').optional(),
});

/** What a runner may ask for: the fields the Agent SDK sends, and nothing that changes what a call costs or reaches. */
export const REQUEST = z.strictObject({
  model: z.string().max(100),
  max_tokens: z.number().int().positive().max(128_000),
  messages: z.array(z.looseObject({ role: z.enum(['user', 'assistant', 'system']) })).min(1),
  system: z.union([z.string(), z.array(z.looseObject({ type: z.literal('text') }))]).optional(),
  tools: z.array(clientTool).max(200).optional(),
  tool_choice: z.looseObject({ type: z.string() }).optional(),
  metadata: z.strictObject({ user_id: z.string().max(1000).optional() }).optional(),
  stream: z.boolean().optional(),
  thinking: z.looseObject({ type: z.string() }).optional(),
  stop_sequences: z.array(z.string()).max(8).optional(),
  temperature: z.number().optional(),
  output_config: z.strictObject({ effort: z.string().optional(), format: z.unknown().optional() }).optional(),
  context_management: z
    .strictObject({
      edits: z.array(z.looseObject({ type: z.string().regex(/^clear_(thinking|tool_uses)_\d{8}$/) })).max(10),
    })
    .optional(),
});

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
  /** How long a provider may take over one call, streaming included. */
  providerTimeoutMs?: number;
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
const PROVIDER_TIMEOUT_MS = 15 * 60_000;

const header = (headers: Headers, name: string) => {
  const value = headers[name];
  return Array.isArray(value) ? value.join(',') : value;
};

export class AgentCalls {
  readonly #o: AgentCallsOptions;
  #line: { stopped: boolean; at: number } | undefined;

  constructor(options: AgentCallsOptions) {
    this.#o = options;
  }

  #now(): number {
    return (this.#o.clock?.() ?? new Date()).getTime();
  }

  /**
   * One call. `read` gives the body, and is called only once the token is good. `gone` is aborted when the runner
   * goes away, which stops the call to the provider.
   */
  async messages(headers: Headers, read: () => Promise<string>, gone?: AbortSignal): Promise<Reply> {
    const started = performance.now();
    const who = await this.#authorise(headers);
    if ('status' in who) return who;
    const betas = (header(headers, 'anthropic-beta') ?? '')
      .split(',')
      .map((b) => b.trim())
      .filter(Boolean);
    const unknown = betas.filter((b) => !BETAS.has(b));
    if (unknown.length)
      return apiError(400, 'invalid_request_error', `The gateway does not allow the beta ${unknown.join(', ')}.`);
    let body: z.infer<typeof REQUEST>;
    try {
      const parsed = REQUEST.safeParse(JSON.parse(await read()));
      if (!parsed.success) {
        const problems = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(body)'}: ${i.code}`);
        return apiError(
          400,
          'invalid_request_error',
          `The gateway does not take this request (${problems.join('; ')}).`,
        );
      }
      body = parsed.data;
    } catch (error) {
      if (error instanceof SyntaxError) return apiError(400, 'invalid_request_error', 'The body is not JSON.');
      throw error;
    }
    const chosen = modelFor(this.#o.profile, who.agent, this.#o.allLocal);
    const provider = chosen.provider === 'local' ? 'local' : 'anthropic';
    const call: Call = { ...who, provider, model: chosen.model };
    priceOf(chosen.model);
    // The policy's model and effort, whatever the runner asked for. The local model takes no effort (LM Studio's own
    // setting decides), so none is sent, and none reaches its cassettes' keys.
    const sent: Record<string, unknown> =
      chosen.provider === 'local'
        ? withoutEffort({ ...body, model: chosen.model })
        : { ...body, model: chosen.model, output_config: { ...body.output_config, effort: chosen.effort } };
    const stream = sent.stream === true;
    const keyed = keyedRequest(sent);
    const key = agentCassetteKey(provider, keyed);
    const { cassettes, spend, caps, mode, providers, log } = this.#o;
    const audit = (outcome: Outcome, usage: Usage = NO_USAGE, reason?: string) =>
      this.#audit(call, key, outcome, usage, performance.now() - started, reason);

    const replaying = mode === 'replay' || mode === 'replay-record';
    const stored = replaying ? cassettes.find(key) : undefined;
    if (stored) {
      await audit('replayed', usageOf(stored.response, stored.stream) ?? NO_USAGE);
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
            'retry-after': String(Math.max(1, Math.ceil((Date.parse(error.resets) - this.#now()) / 1000))),
          })
        : apiError(403, 'permission_error', error.message);
    }

    // The call ends when it takes too long, or when the runner has gone: nobody would read the rest.
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.#o.providerTimeoutMs ?? PROVIDER_TIMEOUT_MS),
      ...(gone ? [gone] : []),
    ]);
    let response: Response;
    try {
      response = await target.send('/v1/messages', JSON.stringify(sent), forwardedHeaders(headers), signal);
    } catch (error) {
      const message = `${provider} could not be reached (${causeOf(error)})`.slice(0, 300);
      await audit('failed', undefined, message);
      // Nothing listening on the local model is a cap: it waits for Martin to start LM Studio.
      if (provider === 'local' && !signal.aborted) await caps.cap('local', { reason: 'unreachable', message });
      return provider === 'local'
        ? apiError(429, 'rate_limit_error', message, { 'retry-after': '300' })
        : apiError(502, 'api_error', message);
    }
    if (!response.ok) {
      const errorBody = await response.text();
      const refusal = capOf(response.status, errorBody);
      await audit('failed', undefined, `${provider} answered ${response.status}`);
      if (refusal) {
        await caps.cap(provider, refusal);
        return apiError(
          429,
          'rate_limit_error',
          `${provider} refuses calls for now (${refusal.reason}): ${refusal.message}`,
          {
            'retry-after': '300',
          },
        );
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

    const record = (raw: string) => {
      if (mode === 'live') return;
      try {
        cassettes.record({
          key,
          kind: 'messages',
          provider,
          model: chosen.model,
          recordedAt: new Date(this.#now()).toISOString(),
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
    };
    if (!stream || !response.body) {
      const raw = await response.text();
      const usage = usageOf(raw, false);
      if (!usage) {
        await audit('failed', undefined, `${provider} answered 200 with something other than a message`);
        return apiError(502, 'api_error', `${provider} answered with something other than a message.`);
      }
      await audit('answered', usage);
      await spend.reconcile();
      record(raw);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: raw };
    }
    return {
      status: 200,
      headers: { 'content-type': contentType(true) },
      body: relay(response.body, async (raw, whole) => {
        const usage = usageOf(raw, true) ?? NO_USAGE;
        if (whole) {
          await audit('answered', usage);
          record(raw);
        } else await audit('failed', usage, 'the stream broke off');
        await spend.reconcile();
      }),
    };
  }

  /**
   * Token counting, for the Agent SDK's budgeting: an estimate, about four characters a token. The same in every mode,
   * so a recorded run and its replay see the same counts and send the same requests.
   */
  async countTokens(headers: Headers, read: () => Promise<string>): Promise<Reply> {
    const who = await this.#authorise(headers);
    if ('status' in who) return who;
    return json(200, { input_tokens: Math.ceil((await read()).length / 4) });
  }

  async #authorise(headers: Headers): Promise<Pick<Call, 'job' | 'workItem' | 'agent'> | Reply> {
    const token = header(headers, 'x-api-key') ?? header(headers, 'authorization')?.replace(/^Bearer\s+/i, '');
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
    const now = this.#now();
    if (this.#line && now - this.#line.at < LINE_FRESH_MS) return this.#line.stopped;
    const [last] = await this.#o.sql<{ type: string }[]>`
      select type from events where type in ('line.stopped', 'line.started') order by seq desc limit 1`;
    this.#line = { stopped: last?.type === 'line.stopped', at: now };
    return this.#line.stopped;
  }

  async #audit(call: Call, key: string, outcome: Outcome, usage: Usage, ms: number, reason?: string): Promise<void> {
    const { sql, log } = this.#o;
    // A replay costs nothing; anything the provider generated is billed, whether or not the stream got through.
    const costUsd = outcome === 'answered' || outcome === 'failed' ? costOf(call.model, usage) : 0;
    const durationMs = Math.round(ms);
    const cacheWrite = (usage.cacheWriteTokens ?? 0) + (usage.cacheWriteHourTokens ?? 0);
    await sql`
      insert into model_calls (id, at, agent, work_item, provider, model, question_set, input_tokens, output_tokens,
                               cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, cassette, outcome, job)
      values (${crypto.randomUUID()}, ${new Date(this.#now()).toISOString()}::timestamptz, ${call.agent},
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

const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

/** Why a fetch failed: Node puts the network's reason, such as ECONNREFUSED, in the error's cause. */
const causeOf = (error: unknown) => {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
    return 'it took too long, or the runner went away';
  const cause = (error as Error)?.cause as (Error & { code?: string }) | undefined;
  return cause?.code ?? cause?.message ?? (error as Error)?.message ?? 'unknown';
};

const contentType = (stream: boolean) => (stream ? 'text/event-stream; charset=utf-8' : 'application/json');

/** A stream's events, as server-sent events: each event's name and its data, parsed where it is JSON. */
export function sseEvents(raw: string): { event: string; data: unknown }[] {
  return raw
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const event =
        lines
          .find((l) => l.startsWith('event:'))
          ?.slice(6)
          .trim() ?? 'message';
      const text = lines
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      let data: unknown = text;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          // An event whose data is not JSON keeps it as text; nothing the gateway reads is in one.
        }
      }
      return { event, data };
    })
    .filter((e) => e.event !== 'message' || e.data !== '');
}

/**
 * Relays a stream to the runner as it arrives, keeping a copy. When it ends, `ended` gets the copy and whether it came
 * whole: a stream that reports an error, breaks off, or that the runner leaves, is not whole, and keeps no cassette.
 */
async function* relay(
  stream: ReadableStream<Uint8Array>,
  ended: (raw: string, whole: boolean) => Promise<void>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let whole = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      yield value;
    }
    raw += decoder.decode();
    const events = sseEvents(raw);
    whole = events.some((e) => e.event === 'message_stop') && !events.some((e) => e.event === 'error');
  } catch {
    // The provider's stream broke off: what came is audited as it stands, below.
  } finally {
    if (!whole) await reader.cancel().catch(() => undefined); // already closed, if it broke
    await ended(raw, whole);
  }
}

interface ApiUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
}

/** The numbers in a usage, without its nulls: a later usage adds what it knows and keeps what it does not. */
const numbers = (usage: ApiUsage | undefined) =>
  Object.fromEntries(Object.entries(usage ?? {}).filter(([, v]) => v !== null && v !== undefined)) as ApiUsage;

const count = (n: number | null | undefined) => Math.max(0, n ?? 0);

/**
 * A response's usage, from its JSON or from its stream's events: `message_start` carries the input and the cache,
 * and each `message_delta` what it knows by then (output, and sometimes input again, or null for what it does not).
 * Undefined for a whole response that is not a message.
 */
export function usageOf(raw: string, stream: boolean): Usage | undefined {
  let usage: ApiUsage = {};
  if (!stream) {
    try {
      const message = JSON.parse(raw) as { type?: string; usage?: ApiUsage };
      if (message?.type !== 'message') return undefined;
      usage = numbers(message.usage);
    } catch {
      return undefined;
    }
  } else {
    for (const { event, data } of sseEvents(raw)) {
      const d = data as { message?: { usage?: ApiUsage }; usage?: ApiUsage };
      if (event === 'message_start') usage = { ...usage, ...numbers(d?.message?.usage) };
      if (event === 'message_delta') usage = { ...usage, ...numbers(d?.usage) };
    }
  }
  const hour = count(usage.cache_creation?.ephemeral_1h_input_tokens);
  return {
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens),
    cacheWriteTokens: Math.max(0, count(usage.cache_creation_input_tokens) - hour),
    cacheWriteHourTokens: hour,
  };
}

/** A request with no effort, and no `output_config` left empty by taking it out. */
function withoutEffort({ output_config, ...rest }: z.infer<typeof REQUEST>) {
  if (!output_config) return rest;
  const { effort: _, ...output } = output_config;
  return Object.keys(output).length ? { ...rest, output_config: output } : rest;
}
