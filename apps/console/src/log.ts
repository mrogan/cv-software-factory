/**
 * Structured logs as JSON lines on stdout. OpenTelemetry's pino instrumentation adds the trace and span ids,
 * and also sends each record to the collector, so logs in Loki link to traces in Tempo.
 */
import { pino } from 'pino';

export const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
