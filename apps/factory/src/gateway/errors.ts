/**
 * What the gateway refuses or fails with, as typed errors. The server turns each into a status and a body, and the
 * client turns them back, so a caller handles the same errors in process and over HTTP.
 *
 * No message here ever holds a request's state or questions, or a provider's response body. A provider's
 * validation error echoes the request it was sent, and a report's text is in that request.
 */
import type { z } from 'zod';

/** A provider's failure: what kind, and the HTTP status if it answered at all. */
export type ProviderErrorKind =
  | 'rate-limited'
  | 'overloaded'
  | 'server'
  | 'network'
  | 'timeout'
  | 'rejected'
  | 'malformed';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | undefined;
  /** How long the provider asked callers to wait, when it said. */
  readonly retryAfterMs: number | undefined;

  constructor(kind: ProviderErrorKind, message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** The request is not one the gateway will send: an alias, a model with no price, or a shape the provider refuses. */
export class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequest';
  }
}

/** A spend cap has been reached. Nothing was sent to the provider. */
export class SpendCapped extends Error {
  readonly cap: 'day' | 'month' | 'work-item';
  readonly limitUsd: number;
  readonly spentUsd: number;
  /** When the cap resets, as an ISO timestamp. A work item's cap does not reset. */
  readonly resets: string | null;

  constructor(cap: 'day' | 'month' | 'work-item', limitUsd: number, spentUsd: number, resets: string | null) {
    super(
      `The ${cap} spend cap of $${limitUsd.toFixed(2)} has been reached ($${spentUsd.toFixed(2)} spent)` +
        (resets ? `; it resets at ${resets}.` : '.'),
    );
    this.name = 'SpendCapped';
    this.cap = cap;
    this.limitUsd = limitUsd;
    this.spentUsd = spentUsd;
    this.resets = resets;
  }
}

/** Replaying, and no cassette holds this request. */
export class CassetteMissing extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`No cassette ${key} holds this request, and this gateway may only replay.`);
    this.name = 'CassetteMissing';
    this.key = key;
  }
}

/** The gateway could not be reached, or answered with something the client does not know. */
export class GatewayUnavailable extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GatewayUnavailable';
    this.status = status;
  }
}

/** What went wrong with a request, as paths and codes only: a Zod error's messages can quote the input. */
export function problemsOf(error: z.ZodError): string[] {
  return error.issues
    .slice(0, 5)
    .map(
      (issue) => `${issue.path.join('.') || 'the request'}: ${issue.code === 'custom' ? issue.message : issue.code}`,
    );
}
