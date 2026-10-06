/**
 * The providers behind the gateway's Messages API: Anthropic, and LM Studio on Martin's Mac, which speaks the same
 * API. Bedrock joins in milestone 11. Each takes a request body as the runner sent it (with the model and effort the
 * policy chose), and returns the provider's response untouched, so a stream can be relayed as it arrives and a
 * cassette keeps the bytes that came over the wire.
 *
 * LM Studio is sent one thing differently: the system messages the Agent SDK puts among the turns (the environment,
 * the tokens left, a nudge) go into the user's turn where they stand, each as a `<system-reminder>`, as Claude Code
 * writes such things where a model takes no system message there (`systemInPlace`). Qwen's chat template takes a
 * system message only at the start, so LM Studio moves each one to the top of the prompt, which then changes on every
 * call a few thousand tokens in. The model is hybrid: most of its layers keep a running state that cannot be wound
 * back to an earlier token, so LM Studio reuses a cached prompt only up to a checkpoint before the first token that
 * differs, and every call read all but the first 2,048 or 4,096 tokens again. In place, each request extends the one
 * before it. The cassette keeps the request as the runner sent it, so a replay is unchanged.
 *
 * `capOf` reads a refusal for a cap the factory does not own: the account's credit spent, the workspace's spend
 * limit reached, or (for the local model) nothing listening. Anthropic signals billing by its error's type where it
 * can (`billing_error`, a 402); credit and the workspace's limit are otherwise told apart only by the message.
 */
import type { ProviderCap } from '@software-factory/events';

export type ProviderName = 'anthropic' | 'local';

export interface MessagesProvider {
  readonly name: ProviderName;
  /** POSTs a body to the provider's `path` (`/v1/messages`, or its `count_tokens`). */
  send(path: string, body: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Response>;
}

/** The request headers a provider is given: the API's version and betas, and nothing that names the caller. */
const FORWARDED = ['anthropic-version', 'anthropic-beta'];

export const forwardedHeaders = (headers: Record<string, string | string[] | undefined>) =>
  Object.fromEntries(
    FORWARDED.flatMap((name) => {
      const value = headers[name];
      return value === undefined ? [] : [[name, Array.isArray(value) ? value.join(',') : value]];
    }),
  );

export class Anthropic implements MessagesProvider {
  readonly name = 'anthropic';
  readonly #apiKey: string;
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor({
    apiKey,
    base = 'https://api.anthropic.com',
    fetch: fetcher = fetch,
  }: { apiKey: string; base?: string; fetch?: typeof fetch }) {
    this.#apiKey = apiKey;
    this.#base = base;
    this.#fetch = fetcher;
  }

  send(path: string, body: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Response> {
    return this.#fetch(`${this.#base}${path}`, {
      method: 'POST',
      body,
      headers: {
        'anthropic-version': '2023-06-01',
        ...headers,
        'content-type': 'application/json',
        'x-api-key': this.#apiKey,
      },
      ...(signal ? { signal } : {}),
    });
  }
}

/** LM Studio's Anthropic-compatible endpoint. It takes no key, and costs nothing. */
export class LocalModels implements MessagesProvider {
  readonly name = 'local';
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor({ base, fetch: fetcher = fetch }: { base: string; fetch?: typeof fetch }) {
    this.#base = base;
    this.#fetch = fetcher;
  }

  send(path: string, body: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Response> {
    return this.#fetch(`${this.#base}${path}`, {
      method: 'POST',
      body: path === '/v1/messages' ? JSON.stringify(systemInPlace(JSON.parse(body))) : body,
      headers: { 'anthropic-version': '2023-06-01', ...headers, 'content-type': 'application/json' },
      ...(signal ? { signal } : {}),
    });
  }
}

interface Message {
  role: string;
  content: unknown;
}

type Block = { type?: unknown; text?: unknown };

/** A message's content as blocks: a string is one block of text. */
const blocksOf = (content: unknown): Block[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];

/**
 * A request with each system message among its turns moved into the user's turn beside it, as a `<system-reminder>`
 * text block where it stood, so that the prompt a local model reads only grows from one call to the next. A tool's
 * results stay first in their turn, as the API asks. The request's own `system` and every other message are as sent.
 */
export function systemInPlace<R extends { messages?: unknown }>(request: R): R {
  if (!Array.isArray(request.messages) || !request.messages.some((m: Message) => m?.role === 'system')) return request;
  const messages: Message[] = [];
  let merging = false;
  for (const message of request.messages as Message[]) {
    const system = message?.role === 'system';
    const text = system
      ? blocksOf(message.content)
          .map((b) => (typeof b.text === 'string' ? b.text : ''))
          .join('')
      : '';
    if (system && !text.trim()) continue;
    const turn: Message = system
      ? { role: 'user', content: [{ type: 'text', text: `<system-reminder>\n${text}\n</system-reminder>` }] }
      : message;
    const last = messages.at(-1);
    // Only a reminder joins a turn: two of the runner's own user turns stay as it sent them.
    if (last?.role === 'user' && turn.role === 'user' && (system || merging)) {
      const blocks = [...blocksOf(last.content), ...blocksOf(turn.content)];
      const results = blocks.filter((b) => b.type === 'tool_result');
      messages[messages.length - 1] = {
        ...last,
        content: [...results, ...blocks.filter((b) => b.type !== 'tool_result')],
      };
    } else messages.push(turn);
    merging = system;
  }
  return { ...request, messages };
}

/** A provider refusing for a cap the factory does not own: why, as a kind callers branch on, and in its own words. */
export class ProviderRefusal {
  readonly reason: ProviderCap;
  readonly message: string;

  constructor(reason: ProviderCap, message: string) {
    this.reason = reason;
    this.message = message;
  }
}

/** Reads an error response for a cap the factory does not own, or undefined for any other failure. */
export function capOf(status: number, body: string): ProviderRefusal | undefined {
  let type = '';
  let message = '';
  try {
    const parsed = JSON.parse(body) as { error?: { type?: string; message?: string } };
    type = parsed.error?.type ?? '';
    message = parsed.error?.message ?? '';
  } catch {
    return undefined;
  }
  const said = message.slice(0, 300) || `${status} ${type}`;
  // Read here, once: callers get a ProviderRefusal and its kind, and never match the words again.
  if (/workspace/i.test(message) && /limit/i.test(message)) return new ProviderRefusal('workspace-limit', said);
  if (status === 402 || type === 'billing_error' || /credit balance/i.test(message)) {
    return new ProviderRefusal('credit', said);
  }
  return undefined;
}
