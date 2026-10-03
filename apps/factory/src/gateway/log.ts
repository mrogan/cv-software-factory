/**
 * Structured logs as JSON lines on stdout, as in the console. OpenTelemetry's pino instrumentation adds the trace
 * and span ids and sends each record to the collector.
 *
 * Nothing logged here carries a request's state or questions, or a provider's response body.
 */
import { type Logger, pino } from 'pino';

export type { Logger };

export const log = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { service: 'gateway' } });
