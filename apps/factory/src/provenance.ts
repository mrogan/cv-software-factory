/**
 * Which records are the app's. Any worker in the factory may send telemetry to the collector, and a record's
 * `service.name` is whatever its sender says: a worker that untrusted input had turned could name itself `website` and
 * plant the logs, metrics and traces the senses read as the app's. So the senses select the app's telemetry by its
 * service and by what only the collector says of a record.
 *
 * The collector first deletes any `k8s.pod.*` attribute a record brings, in any spelling a backend would read as the
 * same, then gives a record that came from a pod in `website` that pod's name and its `rollouts-pod-template-hash`
 * label (deploy/base/telemetry/values/otel-collector.yaml). It watches no other namespace, and nothing else in the
 * cluster sets them on a record that names itself the app: the pod log collector gives every pod's log its pod's name,
 * but always as the `pod-logs` service (deploy/base/pod-logs/values.yaml). So a record of the app's service that
 * carries them came from the app's pods, and one that names itself the app and carries neither came from somewhere
 * else. That holds of what passes through the collector: a worker that could write to a backend directly could write
 * any label, so the readers' fences must let them read and no more.
 *
 * Each backend keeps a different one of the two where a selector can reach it.
 */

/** Loki makes the pod's name one of a stream's labels: a record's own attributes never reach a stream's labels. */
export const LOGS_FROM_THE_APP = 'k8s_pod_name!=""';

/** Prometheus labels a series with the hash, which it promotes, and not the pod's name, which it does not. */
export const METRICS_FROM_THE_APP = 'k8s_pod_label_rollouts_pod_template_hash!=""';

/** The resource attribute the collector stamps: in a trace from Tempo, the app's spans are those whose resource has it. */
export const APP_POD_ATTRIBUTE = 'k8s.pod.name';

/** Tempo keeps every attribute of a span's resource, and `resource.` reads the resource's alone. */
export const TRACES_FROM_THE_APP = `resource.${APP_POD_ATTRIBUTE} != nil`;

/**
 * Which series are the line's: those Prometheus has from a pod in `factory` labelled `app.kubernetes.io/name: line`, as
 * the collector says. Its counts of Martin's security events, and its comparison of what the admin service changes with
 * the events that name each change, page him. It stamps the metrics from that namespace's pods with the namespace and that label, found by the
 * address each came from, after deleting any `k8s.namespace.*` or `k8s.pod.*` attribute a record brought; and the
 * scrapes drop both labels from whatever they take. So no other worker can send a series the alerts to Martin read as
 * the line's, and page him for nothing.
 */
export const METRICS_FROM_THE_LINE = 'k8s_namespace_name="factory", k8s_pod_label_app_kubernetes_io_name="line"';

/**
 * Which series are the admin service's: those from a pod in `factory` labelled `app.kubernetes.io/name: admin`, stamped
 * by the collector as the line's are. Its figures of whether the app holds the flags as set page Martin, so no other
 * worker may send them.
 */
export const METRICS_FROM_THE_ADMIN_SERVICE =
  'k8s_namespace_name="factory", k8s_pod_label_app_kubernetes_io_name="admin"';

/**
 * Which series are the traffic generator's: those from a pod in `factory` labelled `app.kubernetes.io/name: traffic`,
 * stamped by the collector as the line's are. Verify judges a flag at Share on its figures, and Everyone waits on that,
 * so the app, whose code is being judged and which may send the collector metrics of any name and job, may not send
 * them.
 */
export const METRICS_FROM_THE_TRAFFIC_GENERATOR =
  'k8s_namespace_name="factory", k8s_pod_label_app_kubernetes_io_name="traffic"';

/**
 * Which series are the probes': those from a pod in `factory` labelled `app.kubernetes.io/name: probes`, stamped by the
 * collector as the line's are. Their checks of whether the console and the app answer page Martin, and so does their
 * silence, so no other worker may send them: not to page him for nothing, nor to answer for a console that is down.
 */
export const METRICS_FROM_THE_PROBES = 'k8s_namespace_name="factory", k8s_pod_label_app_kubernetes_io_name="probes"';

/**
 * Which series are the gateway's: those from a pod in `factory` labelled `app.kubernetes.io/name: gateway`, stamped by
 * the collector as the line's are. Its spend against the caps pages Martin when a cap is reached, so no other worker may
 * send it.
 */
export const METRICS_FROM_THE_GATEWAY = 'k8s_namespace_name="factory", k8s_pod_label_app_kubernetes_io_name="gateway"';
