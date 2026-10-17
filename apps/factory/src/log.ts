/**
 * Structured logs as JSON lines on stdout, as in the console. OpenTelemetry's pino instrumentation adds the trace
 * and span ids and sends each record to the collector.
 *
 * Nothing logged carries a report's text, a request's state or questions, or a provider's response body.
 */
import { type Logger, pino } from 'pino';

export type { Logger };

/** How many causes deep an error's message and stack follow it. */
const CAUSES = 5;

/**
 * The fields of an error a log keeps besides its type, message and stack: codes and kinds that say what went wrong,
 * never what it went wrong on. Libraries put more on their errors (Postgres's `detail` can quote the row it refused).
 * A code is kept only as text: a DOMException's is a number that says less than its name.
 */
const KEPT = ['code', 'status', 'kind'] as const;

type ErrorLike = Error & { code?: unknown; errors?: unknown };

const isError = (value: unknown): value is ErrorLike =>
  typeof value === 'object' && value !== null && typeof (value as Error).message === 'string';

/** What one error says, where its message says nothing: a refused connection to `localhost` tries each address. */
function said(error: ErrorLike): string {
  if (error.message) return error.message;
  const inner = Array.isArray(error.errors) ? error.errors.filter(isError).map(said).filter(Boolean) : [];
  if (inner.length) return inner.join('; ');
  return typeof error.code === 'string' ? error.code : '';
}

/** The error and each of its causes, as far as `CAUSES`, once each. */
function chain(error: ErrorLike): ErrorLike[] {
  const errors = [error];
  for (let cause = error.cause; isError(cause) && errors.length <= CAUSES && !errors.includes(cause); ) {
    errors.push(cause);
    cause = cause.cause;
  }
  return errors;
}

/**
 * An error as a log keeps it, under `err`: its type, its message and stack with each cause's after them, so
 * `fetch failed` says whether the connection was refused, the name did not resolve or the connection timed out,
 * and of its other fields only those in `KEPT`. pino's own serializer does the same with every field, which is why
 * this is not it.
 *
 * Log the error itself (`{ err: error }`). Where a cause could quote what must not be logged, throw a new error
 * without it, and say so beside it.
 */
export function errSerializer(error: unknown): unknown {
  if (!isError(error)) return error;
  const errors = chain(error);
  const type = error.name && error.name !== 'Error' ? error.name : (error.constructor?.name ?? 'Error');
  const kept: Record<string, unknown> = {
    type,
    message: errors.map(said).filter(Boolean).join(': '),
    stack: errors.map((e) => e.stack ?? `${e.name ?? 'Error'}: ${e.message}`).join('\ncaused by: '),
  };
  for (const key of KEPT) {
    const value = (error as unknown as Record<string, unknown>)[key];
    if (typeof value === 'string' || (key !== 'code' && typeof value === 'number')) kept[key] = value;
  }
  return kept;
}

/** The options every logger of the factory's is made with. */
export const logOptions = (level: string) => ({ level, serializers: { err: errSerializer } });

export const log = pino(logOptions(process.env.LOG_LEVEL ?? 'info'));
