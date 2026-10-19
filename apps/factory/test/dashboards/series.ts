/**
 * Every Prometheus series a dashboard may name, and where it comes from. A query that names anything else draws
 * nothing, and says nothing of why, as the Factory dashboard's logs panel did for months: so the dashboards test fails
 * on it instead. A series added to a dashboard is added here, with its source.
 *
 * The factory's own are checked against the code: each names the instrument that makes it, which must still be
 * created (`createCounter('line.steps', …)` and its kin). The recording rules are checked against the generated rules
 * file. The rest are third-party, named by the exporter or scrape that produces them.
 */
import { SPEND_METRIC } from '../../src/gateway/metrics.ts';

/** The factory's and the console's series, by the instrument that makes each, as Prometheus names it. */
export const INSTRUMENTS: Record<string, string> = {
  line_work_items: 'line.work_items',
  line_stage_oldest_seconds: 'line.stage.oldest',
  line_stage_duration_seconds: 'line.stage.duration',
  line_steps_total: 'line.steps',
  line_holds_total: 'line.holds',
  line_releases_total: 'line.releases',
  line_verifications_total: 'line.verifications',
  gateway_calls_total: 'gateway.calls',
  gateway_call_duration_milliseconds: 'gateway.call.duration',
  [`${SPEND_METRIC}_total`]: SPEND_METRIC,
  gateway_tokens_total: 'gateway.tokens',
  gateway_provider_errors_total: 'gateway.provider.errors',
  gateway_cap_refusals_total: 'gateway.cap.refusals',
  gateway_cap_spent_usd: 'gateway.cap.spent_usd',
  gateway_cap_limit_usd: 'gateway.cap.limit_usd',
  factory_inbox_waiting: 'factory.inbox.waiting',
  factory_triage_signals_total: 'factory.triage.signals',
  factory_triage_signal_to_ticket_seconds: 'factory.triage.signal_to_ticket',
  console_stream_clients: 'console.stream.clients',
  console_stream_events_total: 'console.stream.events',
  console_stream_delay_seconds: 'console.stream.delay',
};

/** Prometheus's recording rules, generated from the policy (`alerts/rules.ts`). */
export const RULES = [
  'line:work_items:max',
  'line:stage_oldest:ratio_to_limit',
  'website:error_budget_remaining:ratio7d',
];

/** Series from outside the factory's code, by what produces them. */
export const THIRD_PARTY: Record<string, string> = {
  up: 'Prometheus, for each scrape target',
  ALERTS: 'Prometheus, for each alerting rule',
  http_server_request_duration_seconds: 'OpenTelemetry’s HTTP instrumentation, in the app, the console and the workers',
  kube_pod_container_status_restarts_total: 'kube-state-metrics',
  argocd_app_info: 'Argo CD’s application controller',
  argocd_app_sync_total: 'Argo CD’s application controller',
  rollout_phase: 'Argo Rollouts’ controller',
  kyverno_admission_requests_total: 'Kyverno’s admission controller',
  traefik_service_requests_total: 'Traefik',
  otelcol_receiver_refused_spans: 'the collectors',
  otelcol_receiver_refused_metric_points: 'the collectors',
  otelcol_receiver_refused_log_records: 'the collectors',
  otelcol_receiver_failed_spans: 'the collectors',
  otelcol_receiver_failed_metric_points: 'the collectors',
  otelcol_receiver_failed_log_records: 'the collectors',
  otelcol_exporter_send_failed_spans: 'the collectors, from the first failure',
  otelcol_exporter_send_failed_metric_points: 'the collectors, from the first failure',
  otelcol_exporter_send_failed_log_records: 'the collectors, from the first failure',
  tempo_receiver_refused_spans: 'Tempo’s distributor',
  tempo_discarded_spans_total: 'Tempo’s distributor, from the first discard',
  loki_discarded_samples_total: 'Loki’s distributor, from the first discard',
};

/** A histogram is named by its base; a query reads its buckets, count or sum. */
export const HISTOGRAM_SUFFIXES = ['_bucket', '_count', '_sum'];
