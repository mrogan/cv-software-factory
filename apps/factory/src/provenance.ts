/**
 * Which records are the app's. Any worker in the factory may send telemetry to the collector, and a record's
 * `service.name` is whatever its sender says: a worker that untrusted input had turned could name itself `website` and
 * plant the logs, metrics and traces the senses read as the app's. So the senses select the app's telemetry by its
 * service and by what only the collector says of a record.
 *
 * The collector first deletes any `k8s.pod.*` attribute a record brings, in any spelling a backend would read as the
 * same, then gives a record that came from a pod in `website` that pod's name and its `rollouts-pod-template-hash`
 * label (deploy/base/telemetry/values/otel-collector.yaml). It watches no other namespace, and nothing else in the
 * cluster sets them, so a record that carries them came from the app's pods, and one that names itself the app and
 * carries neither came from somewhere else.
 *
 * Each backend keeps a different one of the two where a selector can reach it.
 */

/** Loki makes the pod's name one of a stream's labels: a record's own attributes never reach a stream's labels. */
export const LOGS_FROM_THE_APP = 'k8s_pod_name!=""';

/** Prometheus labels a series with the hash, which it promotes, and not the pod's name, which it does not. */
export const METRICS_FROM_THE_APP = 'k8s_pod_label_rollouts_pod_template_hash!=""';

/** Tempo keeps every attribute of a span's resource, and `resource.` reads the resource's alone. */
export const TRACES_FROM_THE_APP = 'resource.k8s.pod.name != nil';
