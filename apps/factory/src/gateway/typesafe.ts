/**
 * The TypeSafe adapter: Jev's one endpoint, `POST /v1/systemone`, with `fetch` and without TypeSafe's SDK. The
 * gateway needs the bytes on the wire for cassettes, and must not trust a response it has not checked.
 *
 * The schemas come from TypeSafe's OpenAPI document (https://api.typesafe.ai/openapi.json). The request is strict,
 * because the factory builds it. The response ignores fields it does not know, since TypeSafe may add some, and
 * is then checked against the request: every question answered once, with an answer of its own type.
 *
 * Failures are `ProviderError`s that never carry the response body, and nothing logged does either: a 422 echoes
 * the request, and a report's text is in that.
 */
import type { Logger } from 'pino';
import { z } from 'zod';
import { BadRequest, ProviderError, problemsOf } from './errors.ts';

export const PROVIDER = 'typesafe';

/** A pinned version such as `jev-1.13.0`. An alias such as `jev-latest` can change what answers under our feet. */
export const PINNED_MODEL = /^jev-\d+\.\d+\.\d+$/;

/** TypeSafe's "string, object or array": how a state, an instruction or a criterion may be written. */
const described = z.union([z.string(), z.record(z.string(), z.json()), z.array(z.json())]);

const question = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('choice'),
    instructions: described.nullable().optional(),
    criteria: z
      .record(z.string(), described.nullable())
      .refine((criteria) => Object.keys(criteria).length > 0, 'a choice needs at least one option'),
  }),
  z.strictObject({
    type: z.literal('score'),
    instructions: described.nullable().optional(),
    /** Ordered: a level's position is its score, starting at zero. */
    criteria: z.array(described).min(1),
  }),
  z.strictObject({
    type: z.literal('noul'),
    instructions: described.nullable().optional(),
    criteria: z
      .strictObject({ true: described.nullable().optional(), false: described.nullable().optional() })
      .nullable()
      .optional(),
  }),
]);

export const request = z.strictObject({
  model: z.string().regex(PINNED_MODEL, 'the model must be pinned, such as jev-1.13.0, and never an alias'),
  state: described,
  questions: z
    .record(z.string().min(1), question)
    .refine((questions) => Object.keys(questions).length > 0, 'a request needs at least one question'),
});

export type TypeSafeRequest = z.infer<typeof request>;
export type Question = TypeSafeRequest['questions'][string];

const probability = z.number().min(0).max(1);
const probabilities = z.record(z.string(), probability);

export const answer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('choice'), choice: z.string(), confidence: probability, probabilities }),
  z.object({
    type: z.literal('score'),
    score: z.number(),
    confidence: probability,
    legend: z.record(z.string(), described),
    probabilities,
  }),
  z.object({ type: z.literal('noul'), noul: probability }),
]);

export const response = z.object({
  model: z.string(),
  answers: z.record(z.string(), answer),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
});

export type Answer = z.infer<typeof answer>;
export type TypeSafeResponse = z.infer<typeof response>;

const malformed = (what: string) => new ProviderError('malformed', `TypeSafe's response is not usable: ${what}.`);

/**
 * Reads a response body, from the wire or from a cassette, and checks it against the request that was sent. The
 * errors name paths and questions, never values.
 */
export function parseResponse(sent: TypeSafeRequest, body: string): TypeSafeResponse {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw malformed('it is not JSON');
  }
  const parsed = response.safeParse(json);
  if (!parsed.success)
    throw malformed(`it does not match the documented shape (${problemsOf(parsed.error).join('; ')})`);
  const { model, answers } = parsed.data;
  if (model !== sent.model) throw malformed('it names a different model from the one asked');
  const asked = Object.keys(sent.questions);
  if (Object.keys(answers).length !== asked.length) throw malformed('it answers a different set of questions');
  for (const name of asked) {
    const given = answers[name];
    const wanted = sent.questions[name];
    if (!given || !wanted) throw malformed(`question ${name} has no answer`);
    if (given.type !== wanted.type) throw malformed(`the answer to question ${name} is of the wrong type`);
    if (given.type === 'choice' && wanted.type === 'choice' && !Object.hasOwn(wanted.criteria, given.choice)) {
      throw malformed(`the answer to question ${name} is not one of its options`);
    }
  }
  return parsed.data;
}

export interface TypeSafeOptions {
  apiKey: string;
  /** Without a trailing slash. Tests point it at a fake server. */
  baseUrl?: string;
  /** For one attempt, in milliseconds. */
  timeoutMs?: number;
  /** Retries after the first attempt. */
  maxRetries?: number;
  log: Logger;
  /** Injected so tests need neither real waiting nor real chance. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  fetch?: typeof fetch;
}

export const DEFAULT_URL = 'https://api.typesafe.ai';
const BACKOFF_MS = 500;
const MAX_WAIT_MS = 30_000;

/** How long a `Retry-After` header asks for, in milliseconds: it is a number of seconds, or an HTTP date. */
export function retryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

const retryable = (error: ProviderError) =>
  ['rate-limited', 'overloaded', 'server', 'network', 'timeout'].includes(error.kind);

export class TypeSafe {
  readonly #options: Required<Omit<TypeSafeOptions, 'apiKey'>>;
  readonly #apiKey: string;

  constructor(options: TypeSafeOptions) {
    this.#apiKey = options.apiKey;
    this.#options = {
      baseUrl: DEFAULT_URL,
      timeoutMs: 10_000,
      maxRetries: 3,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      random: Math.random,
      now: Date.now,
      fetch,
      ...options,
    };
  }

  /**
   * Asks the questions. Returns the answers, checked, and the body exactly as it came, which is what a cassette
   * keeps. Retries a rate limit, an overload, a server error, a timeout and a dropped connection, with
   * exponential backoff and jitter, and waits as long as `Retry-After` asks (up to 30 seconds).
   */
  async judge(input: unknown): Promise<{ response: TypeSafeResponse; body: string }> {
    const checked = request.safeParse(input);
    if (!checked.success)
      throw new BadRequest(`TypeSafe would refuse this request (${problemsOf(checked.error).join('; ')}).`);
    const sent = checked.data;
    const { maxRetries, log, sleep, random } = this.#options;
    for (let attempt = 0; ; attempt++) {
      try {
        const body = await this.#attempt(sent);
        return { response: parseResponse(sent, body), body };
      } catch (error) {
        if (!(error instanceof ProviderError) || !retryable(error) || attempt >= maxRetries) throw error;
        const ceiling = Math.min(MAX_WAIT_MS, BACKOFF_MS * 2 ** attempt);
        const waitMs = Math.min(MAX_WAIT_MS, error.retryAfterMs ?? ceiling / 2 + (random() * ceiling) / 2);
        log.warn(
          { provider: PROVIDER, kind: error.kind, status: error.status, retry: attempt + 1, waitMs },
          'TypeSafe call failed; retrying',
        );
        await sleep(waitMs);
      }
    }
  }

  async #attempt(sent: TypeSafeRequest): Promise<string> {
    const { baseUrl, timeoutMs, fetch: send, now } = this.#options;
    let result: Response;
    try {
      result = await send(`${baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(sent),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (result.ok) return await result.text();
    } catch (error) {
      // The error's own message is not passed on: what a network library says can include what it was sent.
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new ProviderError(
        timedOut ? 'timeout' : 'network',
        timedOut ? `TypeSafe did not answer within ${timeoutMs} ms.` : 'TypeSafe could not be reached.',
      );
    }
    // The body of an error is never read: a validation error echoes the request.
    await result.body?.cancel().catch(() => {});
    const { status } = result;
    const wait = retryAfterMs(result.headers.get('retry-after'), now());
    const kind =
      status === 429 ? 'rate-limited' : status === 529 ? 'overloaded' : status >= 500 ? 'server' : 'rejected';
    throw new ProviderError(kind, `TypeSafe answered with status ${status}.`, status, wait);
  }
}
