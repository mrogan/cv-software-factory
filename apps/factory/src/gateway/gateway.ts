/**
 * The gateway: the only way from the factory to a model (spec section 7.1, ADR 0003). A caller names the agent,
 * the work item, the question set and a pinned model, and gives the state and the questions. The gateway checks
 * the request, finds or makes the answer, counts what it cost, and keeps an audit row and a log line for every
 * call: never the state, the questions' text or a provider's body.
 *
 * Modes:
 * - `live`: calls the provider and records nothing.
 * - `record`: calls the provider and records a cassette.
 * - `replay`: answers from cassettes only. A request with none is a `CassetteMissing`. CI runs here.
 * - `replay-record`: replays, and on a miss calls the provider and records. For development.
 *
 * With no API key the gateway replays whatever mode was asked for. A replay costs nothing and is not held back by
 * a spend cap.
 */
import { AGENTS, type Agent } from '@software-factory/events';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { type Cassettes, cassetteKey } from './cassettes.ts';
import { BadRequest, CassetteMissing, ProviderError, problemsOf, SpendCapped } from './errors.ts';
import type { Logger } from './log.ts';
import * as instruments from './metrics.ts';
import { costOf, priceOf } from './prices.ts';
import type { Spend } from './spend.ts';
import {
  PINNED_MODEL,
  PROVIDER,
  parseResponse,
  type TypeSafe,
  type TypeSafeRequest,
  type TypeSafeResponse,
  request as typesafeRequest,
} from './typesafe.ts';

export const MODES = ['live', 'record', 'replay', 'replay-record'] as const;
export type Mode = (typeof MODES)[number];

/**
 * What a caller sends. The questions and the state are TypeSafe's (see `typesafe.ts`). Build them the same way
 * every time: a request's cassette is keyed by their text, option order included.
 */
export interface JudgeRequest {
  agent: Agent;
  /** The work item the call is for, which its cap counts against, or null for none. */
  workItem: string | null;
  /** The question set and its version, such as `triage/v1`. */
  questionSet: string;
  /** A pinned model, such as `jev-1.13.0`. */
  model: string;
  state: TypeSafeRequest['state'];
  questions: TypeSafeRequest['questions'];
}

export interface Judgement {
  model: string;
  answers: TypeSafeResponse['answers'];
  usage: { inputTokens: number; outputTokens: number };
  /** In US dollars. Nothing for a replay. */
  costUsd: number;
  durationMs: number;
  /** The key of the request, which names its cassette. A file exists if `source` is `cassette` or it was recorded. */
  cassette: string;
  source: 'provider' | 'cassette';
}

export type Outcome = 'answered' | 'replayed' | 'refused' | 'failed';

/** The request as an HTTP body or an in-process call gives it, before the provider's own rules are applied. */
export const judgeRequest = z.strictObject({
  agent: z.enum(AGENTS),
  workItem: z
    .string()
    .regex(/^[1-9]\d{0,8}$/)
    .nullable(),
  questionSet: z.string().regex(/^[a-z][a-z0-9-]*\/v\d+$/, 'a question set and version, such as triage/v1'),
  model: z.string().max(80),
  state: z.unknown(),
  questions: z.unknown(),
});

export interface GatewayOptions {
  sql: Sql;
  spend: Spend;
  cassettes: Cassettes;
  /** What was asked for. With no `typesafe`, the gateway replays whatever this says. */
  mode: Mode;
  /** The provider's adapter. Without one the gateway has no key and replays only. */
  typesafe?: TypeSafe | undefined;
  log: Logger;
  clock?: () => Date;
}

interface Call {
  agent: Agent;
  workItem: string | null;
  model: string;
  questionSet: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  cassette: string | null;
  outcome: Outcome;
}

export class Gateway {
  /** What the gateway does, which is replay when it has no key to do anything else. */
  readonly mode: Mode;
  readonly #options: GatewayOptions;
  readonly #clock: () => Date;

  constructor(options: GatewayOptions) {
    this.#options = options;
    this.#clock = options.clock ?? (() => new Date());
    this.mode = options.typesafe ? options.mode : 'replay';
    if (!options.typesafe && options.mode !== 'replay') {
      options.log.warn({ asked: options.mode, mode: 'replay' }, 'no TYPESAFE_API_KEY: replaying cassettes only');
    }
  }

  async judge(input: JudgeRequest): Promise<Judgement> {
    const started = performance.now();
    const envelope = judgeRequest.safeParse(input);
    if (!envelope.success) throw new BadRequest(`The request is not valid (${problemsOf(envelope.error).join('; ')}).`);
    const { agent, workItem, questionSet, model } = envelope.data;
    const call = { agent, workItem, model: model.slice(0, 80), questionSet };
    let key: string | null = null;
    try {
      const sent = this.#prepare(envelope.data);
      key = cassetteKey(PROVIDER, sent);
      const { mode } = this;
      const { cassettes, spend, typesafe } = this.#options;

      const stored = mode === 'live' || mode === 'record' ? undefined : cassettes.find(key);
      if (stored) {
        const response = parseResponse(sent, stored.response);
        return await this.#finish(call, started, key, 'replayed', 'cassette', response, 0);
      }
      // With no adapter the mode is already `replay`; the check also tells the compiler there is one below.
      if (mode === 'replay' || !typesafe) throw new CassetteMissing(key);

      await spend.check(workItem);
      const { response, body } = await typesafe.judge(sent);
      const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
      const judgement = await this.#finish(
        call,
        started,
        key,
        'answered',
        'provider',
        response,
        costOf(sent.model, usage),
      );
      // The call is paid for, counted and answered by now: a cassette that cannot be written loses a replay, not the
      // answer, so it is logged and the caller still gets what it paid for, and a cap it reached is still reported.
      await spend.reconcile();
      if (mode !== 'live') {
        try {
          cassettes.record({
            key,
            provider: PROVIDER,
            model: sent.model,
            recordedAt: this.#clock().toISOString(),
            request: sent,
            response: body,
          });
        } catch (error) {
          const reason = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
          this.#options.log.warn({ cassette: key, reason }, 'the cassette could not be written');
        }
      }
      return judgement;
    } catch (error) {
      const outcome = refusal(error);
      if (outcome) {
        await this.#record(
          {
            ...call,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            durationMs: elapsed(started),
            cassette: key,
            outcome,
          },
          error,
        );
      }
      throw error;
    }
  }

  /** The request as the provider takes it, if it is one the gateway will send. */
  #prepare({ model, state, questions }: z.infer<typeof judgeRequest>): TypeSafeRequest {
    if (!PINNED_MODEL.test(model)) {
      throw new BadRequest(`Model ${model} is not pinned. Name a version such as jev-1.13.0, never an alias.`);
    }
    priceOf(model);
    const parsed = typesafeRequest.safeParse({ model, state, questions });
    if (!parsed.success)
      throw new BadRequest(
        `The questions or state are not ones TypeSafe takes (${problemsOf(parsed.error).join('; ')}).`,
      );
    return parsed.data;
  }

  async #finish(
    call: Pick<Call, 'agent' | 'workItem' | 'model' | 'questionSet'>,
    started: number,
    key: string,
    outcome: 'answered' | 'replayed',
    source: Judgement['source'],
    response: TypeSafeResponse,
    costUsd: number,
  ): Promise<Judgement> {
    const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
    const durationMs = elapsed(started);
    await this.#record({ ...call, ...usage, costUsd, durationMs, cassette: key, outcome });
    return { model: response.model, answers: response.answers, usage, costUsd, durationMs, cassette: key, source };
  }

  /** The audit row, the log line and the metrics for one call. */
  async #record(call: Call, error?: unknown): Promise<void> {
    const { sql, log } = this.#options;
    await sql`
      insert into model_calls (id, at, agent, work_item, provider, model, question_set, input_tokens, output_tokens,
                               cost_usd, duration_ms, cassette, outcome)
      values (${crypto.randomUUID()}, ${this.#clock().toISOString()}::timestamptz, ${call.agent}, ${call.workItem},
              ${PROVIDER}, ${call.model}, ${call.questionSet}, ${call.inputTokens}, ${call.outputTokens},
              ${call.costUsd}, ${call.durationMs}, ${call.cassette}, ${call.outcome})`;
    const attributes = { agent: call.agent, provider: PROVIDER, model: call.model, outcome: call.outcome };
    instruments.calls.add(1, attributes);
    instruments.latency.record(call.durationMs, attributes);
    if (call.costUsd > 0)
      instruments.spend.add(call.costUsd, { agent: call.agent, provider: PROVIDER, model: call.model });
    const level = call.outcome === 'failed' ? 'error' : call.outcome === 'refused' ? 'warn' : 'info';
    log[level](
      {
        agent: call.agent,
        workItem: call.workItem,
        provider: PROVIDER,
        model: call.model,
        questionSet: call.questionSet,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        costUsd: call.costUsd,
        durationMs: call.durationMs,
        cassette: call.cassette,
        outcome: call.outcome,
        // Why, when it was not answered: the error's own words, which never hold a request or a response.
        ...(error instanceof Error ? { reason: error.message } : {}),
      },
      'model call',
    );
  }
}

/** The audit outcome for an error the gateway knows, or undefined for one it does not, such as a lost database. */
function refusal(error: unknown): 'refused' | 'failed' | undefined {
  if (error instanceof ProviderError) return 'failed';
  if (error instanceof BadRequest || error instanceof SpendCapped || error instanceof CassetteMissing) return 'refused';
  return undefined;
}

const elapsed = (started: number) => Math.round(performance.now() - started);
