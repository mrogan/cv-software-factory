/**
 * The telemetry backends, found where the environment says. The defaults are the inner loop's: Prometheus, Loki and
 * Tempo reached through port-forwards (AGENTS.md). In the cluster the Deployments set the service addresses.
 */
import { Loki } from './loki.ts';
import { Prometheus } from './prometheus.ts';
import { Tempo } from './tempo.ts';

export function telemetryFrom(env: NodeJS.ProcessEnv = process.env) {
  return {
    prometheus: new Prometheus(env.PROMETHEUS_URL ?? 'http://localhost:9090'),
    loki: new Loki(env.LOKI_URL ?? 'http://localhost:3100'),
    tempo: new Tempo(env.TEMPO_URL ?? 'http://localhost:3200'),
  };
}
