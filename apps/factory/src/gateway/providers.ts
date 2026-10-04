/**
 * The providers behind the gateway's Messages API: Anthropic, and LM Studio on Martin's Mac, which speaks the same
 * API. Bedrock joins in milestone 11. Each takes a request body as the runner sent it (with the model and effort the
 * policy chose), and returns the provider's response untouched, so a stream can be relayed as it arrives and a
 * cassette keeps the bytes that came over the wire.
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
      body,
      headers: { 'anthropic-version': '2023-06-01', ...headers, 'content-type': 'application/json' },
      ...(signal ? { signal } : {}),
    });
  }
}

/** A provider refusing for a cap the factory does not own: why, and in its own words. */
export interface ProviderRefusal {
  reason: ProviderCap;
  message: string;
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
  if (/workspace/i.test(message) && /limit/i.test(message)) return { reason: 'workspace-limit', message: said };
  if (status === 402 || type === 'billing_error' || /credit balance/i.test(message))
    return { reason: 'credit', message: said };
  return undefined;
}
