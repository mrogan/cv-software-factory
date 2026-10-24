/**
 * The figures the privacy page gives, copied from where they are set, since the image is built without them; a test
 * holds each to its source.
 */

/** How many days each backend keeps what the server records: Loki's 168h, Tempo's 72h and Prometheus's 7d. */
export const KEPT_DAYS = { logs: 7, traces: 3, metrics: 7 } as const;

/** How long signing in counts the tries from one address: the admin service's sign-in limit (`LIMITS`). */
export const TRIES_MINUTES = 10;
