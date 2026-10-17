#!/usr/bin/env bash
# Proves the network policies in deploy/, and that no service account of ours may read the scoreboard's Secrets:
# `make egress`.
#
# Only the gateway (TypeSafe, Anthropic) and the GitHub worker (GitHub and GHCR) may reach the internet, over TLS, and
# only triage and runners' agent pods may reach the gateway. This starts a pod labelled like a worker, which is what a
# compromised one would be, and shows that it cannot reach TypeSafe, GitHub, the gateway, the GitHub worker, the app or
# a public address, while the gateway can reach TypeSafe and the GitHub worker can reach GitHub.
#
# Then the line, which reaches the Kubernetes API and the probes' verification, and not another address on the API's
# port, the node's other ports, the probes' page reader or the app.
#
# Then the readers of telemetry (triage, the intake, the log watcher and the line), which query Prometheus, Loki and
# Tempo through the read-only proxy in `telemetry` and cannot write through it: not metrics, not logs, not a reload of
# Prometheus or a flush of Tempo. They cannot reach the backends themselves, Tempo's intake, Grafana, or a stranger in
# `telemetry` listening on the backends' ports. And Prometheus, asked directly, will not reload: its lifecycle
# endpoints are off.
#
# Then the runners (ADR 0008): a pod made like an agent pod (its labels, no DNS, the line's two addresses in its hosts)
# reaches the gateway and the line's handback and nothing else: not GitHub, the Kubernetes API, the cloud metadata
# address, Postgres, the console or the host, nor a name. A pod labelled like a prepare pod reaches GitHub and the npm
# registry, and none of the cluster.
#
# Then the release (milestone 6): the traffic generator reaches the app only through Traefik, its front door; a pod
# made like the canary's analysis Job reaches the app's stable and canary Services and nothing else; a pod labelled
# like the Argo Rollouts controller reaches the Kubernetes API and Prometheus and not the internet; and in Kyverno's
# namespace, a pod labelled like the admission controller reaches GHCR and Sigstore's trust root, while one without
# that label reaches neither.
#
# Then the app's own pods, whose code agents write: a pod labelled like them reaches DNS and the collector, and not
# Prometheus, Loki, Tempo, Postgres, the gateway, the Kubernetes API or the internet. The app is reached through Traefik
# and by the probes, the crawler and the analysis, and not by another pod beside it.
#
# Then the scoreboard, which holds the answer key (milestone 6): it reaches Postgres, and nothing else: not the
# collector, the gateway, the GitHub worker, the console, the probes, Prometheus, Loki, the app, the Kubernetes API, the
# host, the metadata address or the internet. Nothing can reach it, as it serves nothing; its fence's ingress is
# checked in scoreboard-fences.test.ts. And no service account of ours, or of a chart but Argo Rollouts' controller,
# may read its Secrets or reach them through a pod: each is asked of the API server (`kubectl auth can-i --as`).
#
# Every pod this starts runs an image the cluster already runs, pinned by digest, so nothing else is pulled and
# admission control lets it in: the workers' pod the factory image the gateway runs, the runners' pods and the ones in
# Kyverno's and Argo Rollouts' namespaces the runner image the line pins (Node is on its PATH), and the analysis Job's
# and the app's the `factory-browser` image the analysis pins. Each tries an address with Node's `fetch`, or, to name
# the app's host to Traefik, with `http.get`.
#
# A check that must be blocked passes only when the connection is refused, reset, unreachable or never answered, as a
# policy blocks it: any other failure, such as a name that does not resolve, proves nothing about the fence.
#
# A check whose `kubectl exec` fails is a FAIL naming the exit status, and the rest go on: an exec lands in a pod being
# replaced, or its Node, beside the container's own, runs it out of memory. The deployments checked from, and the
# proxy, are rolled out before anything starts, so a run during a rollout waits for it; one Argo CD has yet to sync
# is not waited for.
#
# The controls matter: if the gateway could not reach TypeSafe either, the pod's failure would prove only that the
# network was down.
set -euo pipefail

context="${KUBE_CONTEXT:-k3d-software-factory}"
kubectl=(kubectl --context "$context" -n factory)
pod=egress-intruder

image=$("${kubectl[@]}" get deployment gateway -o jsonpath='{.spec.template.spec.containers[0].image}')
runner_image=$("${kubectl[@]}" get deployment line -o jsonpath='{.spec.template.spec.initContainers[0].image}')
browser_image=$(kubectl --context "$context" get clusteranalysistemplate website-step \
  -o jsonpath='{.spec.metrics[?(@.name=="journeys")].provider.job.spec.template.spec.containers[0].image}')
runners=(kubectl --context "$context" -n runners)

# The deployments the checks run in, and the read-only proxy the readers query, rolled out first: straight after a
# deploy, an exec could land in a pod being replaced. kubectl says why one that has not rolled out has not.
for deployment in factory/gateway factory/github factory/triage factory/intake factory/logs factory/line \
  factory/traffic factory/probes factory/crawler scoreboard/scoreboard telemetry/query; do
  if ! kubectl --context "$context" -n "${deployment%%/*}" rollout status "deployment/${deployment#*/}" \
    --timeout=3m >/dev/null; then
    echo "$deployment has not rolled out: run this again when it has." >&2
    exit 1
  fi
done
cleanup() {
  rm -f "${exec_errors:-}"
  # Each delete goes on whether the one before failed, so no probe pod is left behind.
  "${kubectl[@]}" delete pod "$pod" --ignore-not-found --wait=false >/dev/null || true
  "${runners[@]}" delete pod egress-agent egress-prepare --ignore-not-found --wait=false >/dev/null || true
  kubectl --context "$context" -n website delete pod egress-journeys egress-app egress-stranger --ignore-not-found \
    --wait=false >/dev/null || true
  kubectl --context "$context" -n argo-rollouts delete pod egress-rollouts --ignore-not-found --wait=false >/dev/null || true
  kubectl --context "$context" -n kyverno delete pod egress-admission egress-kyverno --ignore-not-found --wait=false >/dev/null || true
  kubectl --context "$context" -n telemetry delete pod egress-stranger --ignore-not-found --wait=false >/dev/null || true
}
trap cleanup EXIT
# What a failed exec said, for its FAIL line.
exec_errors=$(mktemp)

# What a pod runs to try an address: prints the HTTP status, or why it could not connect. A server's certificate is
# not checked: the Kubernetes API's is the cluster's own, and reaching it at all is what counts. Given a host as well,
# it names that host over plain HTTP, as a visitor's browser does to Traefik; `fetch` will not send a Host header. A
# tcp:// address is only connected to, for a server that does not speak HTTP, such as Postgres.
try='process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const blocks = ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "TimeoutError"];
const names = ["ENOTFOUND", "EAI_AGAIN"];
// An address may start with a method, as "POST http://...": it is sent with an empty body.
const [target, host] = process.argv.slice(1);
const [method, url] = target.includes(" ") ? target.split(" ") : ["GET", target];
const tcp = url.startsWith("tcp://") && new URL(url);
const get = tcp
  ? new Promise((resolve, reject) => {
      const socket = require("node:net").connect({ host: tcp.hostname, port: Number(tcp.port), timeout: 6000 }, () => {
        socket.end();
        resolve({ tcp: true });
      });
      socket.on("timeout", () => socket.destroy(Object.assign(new Error("timeout"), { code: "TimeoutError" })));
      socket.on("error", reject);
    })
  : host
  ? new Promise((resolve, reject) => {
      const req = require("node:http").get(url, { headers: { host }, timeout: 6000 }, (r) => {
        r.resume();
        resolve({ status: r.statusCode });
      });
      req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "TimeoutError" })));
      req.on("error", reject);
    })
  : fetch(url, { method, body: method === "GET" ? undefined : "", signal: AbortSignal.timeout(6000) });
get.then(
  (r) => console.log(r.tcp ? "reached, TCP" : "reached, HTTP " + r.status),
  (e) => {
    const code = e.cause?.code ?? e.code ?? e.name;
    console.log((blocks.includes(code) ? "blocked: " : names.includes(code) ? "no name: " : "failed: ") + code);
  })'

# Starts a pod that idles, or runs the script given, with the fences every namespace here enforces (the restricted
# standard).
# $1: namespace; $2: name; $3: image; $4: Node's path in it; $5: its labels, one per line; $6: more of its spec; $7:
# what it runs.
start_pod() {
  local script=${7:-'setTimeout(() => {}, 600000)'}
  kubectl --context "$context" -n "$1" delete pod "$2" --ignore-not-found --wait >/dev/null
  kubectl --context "$context" -n "$1" apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $2
  labels:
$(sed 's/^/    /' <<<"$5")
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
${6:-}
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: $2
      image: $3
      command: [$4, -e, '$script']
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: [ALL]
EOF
}

# Addresses, for the agent pod, which has no DNS, and for the checks of the node's own ports.
ip() { kubectl --context "$context" -n "$1" get service "$2" -o jsonpath='{.spec.clusterIP}'; }
gateway_ip=$(ip factory gateway) line_ip=$(ip factory line) github_ip=$(ip factory github)
api_ip=$(ip default kubernetes) postgres_ip=$(ip factory postgres) console_ip=$(ip factory console)
website_ip=$(ip website website)
node_ip=$(kubectl --context "$context" get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')

# A worker's labels, which is what a compromised one would have.
start_pod factory "$pod" "$image" /nodejs/bin/node "app.kubernetes.io/name: intruder
app.kubernetes.io/part-of: software-factory
app.kubernetes.io/component: worker"
# A runner's two pods. The agent pod's spec is what the line writes into it: no DNS, and the two addresses it needs.
start_pod runners egress-agent "$runner_image" node "app.kubernetes.io/part-of: software-factory
factory.mrogan.dev/runner: agent" "  dnsPolicy: None
  dnsConfig:
    nameservers: [127.0.0.1]
  hostAliases:
    - { ip: $gateway_ip, hostnames: [gateway.factory.svc] }
    - { ip: $line_ip, hostnames: [line.factory.svc] }"
start_pod runners egress-prepare "$runner_image" node "app.kubernetes.io/part-of: software-factory
factory.mrogan.dev/runner: prepare"
# The analysis Job's pod, by its labels in the ClusterAnalysisTemplate, on its image.
start_pod website egress-journeys "$browser_image" node "app.kubernetes.io/name: journeys
app.kubernetes.io/part-of: software-factory"
# The app's pods by the one label its fence selects on, and not by all of theirs: neither the app's Services nor its
# ReplicaSets must take this pod for one of theirs. And a pod beside the app that no policy selects.
start_pod website egress-app "$browser_image" node "app.kubernetes.io/name: website"
start_pod website egress-stranger "$browser_image" node "app.kubernetes.io/name: egress-stranger"
# The controllers' pods by the one label their policies select on, and not by all of their own: their ReplicaSets
# must not take these pods for theirs.
start_pod argo-rollouts egress-rollouts "$runner_image" node "app.kubernetes.io/component: rollouts-controller"
start_pod kyverno egress-admission "$runner_image" node "app.kubernetes.io/component: admission-controller"
start_pod kyverno egress-kyverno "$runner_image" node "app.kubernetes.io/component: reports-controller"
# A pod in `telemetry` that is none of its backends, answering on their query ports, as anything new there might.
start_pod telemetry egress-stranger "$runner_image" node "app.kubernetes.io/name: egress-stranger" "" \
  'for (const port of [9090, 3100, 3200]) require("node:http").createServer((q, r) => r.end("stranger")).listen(port)'
for started in factory/$pod runners/egress-agent runners/egress-prepare website/egress-journeys website/egress-app \
  website/egress-stranger argo-rollouts/egress-rollouts kyverno/egress-admission kyverno/egress-kyverno \
  telemetry/egress-stranger; do
  kubectl --context "$context" -n "${started%%/*}" wait "pod/${started#*/}" --for=condition=Ready --timeout=2m >/dev/null
done
# The policy reaches a new pod a moment after it starts.
sleep 5
stranger_ip=$(kubectl --context "$context" -n telemetry get pod egress-stranger -o jsonpath='{.status.podIP}')

failed=0
# $1: what is being tried; $2: where from (the pod); $3: the address; $4: blocked or reached, as it must be; $5: the
# host to name, if any.
expect() {
  local result
  local namespace=factory target=$2 node=/nodejs/bin/node
  # A target written <namespace>:<pod> runs the node on its PATH, which every image keeps but the factory image, whose
  # node is /nodejs/bin/node. So the probes and the crawler, on the browser image, are written factory:<pod> too; the
  # scoreboard runs the factory image.
  if [[ "$2" == *:* ]]; then namespace=${2%%:*} target=${2#*:} node=node; fi
  if [ "$namespace" = scoreboard ]; then node=/nodejs/bin/node; fi
  local status=0
  # An exec that fails is that check's FAIL, and the rest go on. One killed (137) ran out of memory beside the
  # container's own process, or landed in a pod being replaced.
  result=$(kubectl --context "$context" -n "$namespace" exec "$target" -- "$node" -e "$try" "$3" ${5:+"$5"} \
    2>"$exec_errors") || status=$?
  if [ "$status" != 0 ]; then
    local why
    why=$(tail -n 1 "$exec_errors")
    if [ "$status" = 137 ]; then why="killed${why:+; $why}"; fi
    printf '  FAIL  %-62s kubectl exec into %s exited %s%s (wanted %s)\n' "$1" "$2" "$status" "${why:+: $why}" "$4"
    failed=1
  elif [[ "$result" == "$4"* ]]; then printf '  ok    %-62s %s\n' "$1" "$result"; else
    printf '  FAIL  %-62s %s (wanted %s)\n' "$1" "$result" "$4"
    failed=1
  fi
}

echo "A pod labelled like a worker (${pod}), the gateway and the GitHub worker:"
expect "the gateway reaches TypeSafe" deployment/gateway https://api.typesafe.ai reached
expect "the worker cannot reach TypeSafe" "$pod" https://api.typesafe.ai blocked
expect "the worker cannot reach GitHub" "$pod" https://api.github.com blocked
expect "the worker cannot reach a public address" "$pod" https://1.1.1.1 blocked
expect "the worker cannot reach the gateway" "$pod" http://gateway:8080/health blocked
expect "the worker cannot reach the GitHub worker" "$pod" http://github:8080/health blocked
expect "the worker cannot reach the app" "$pod" http://website.website blocked
expect "the worker cannot reach Prometheus" "$pod" http://prometheus-server.telemetry/-/healthy blocked
expect "the gateway cannot reach the app" deployment/gateway http://website.website blocked
expect "the GitHub worker reaches GitHub" deployment/github https://api.github.com reached
expect "the GitHub worker reaches GHCR" deployment/github https://ghcr.io/v2/ reached
expect "the GitHub worker cannot reach the app" deployment/github http://website.website blocked
expect "the GitHub worker cannot reach the gateway" deployment/github http://gateway:8080/health blocked
expect "triage reaches the gateway" deployment/triage http://gateway:8080/health reached
expect "the intake cannot reach the gateway" deployment/intake http://gateway:8080/health blocked
expect "the worker cannot reach the probes" "$pod" http://probes:8080/health blocked
expect "the worker cannot reach the probes' verification" "$pod" http://probes:8081/health blocked

echo "The line:"
expect "the line reaches the Kubernetes API" deployment/line "https://$api_ip/version" reached
expect "the line reaches the API server on the node" deployment/line "https://$node_ip:6443/version" reached
expect "the line reaches the probes' verification" deployment/line http://probes:8081/health reached
expect "the line cannot reach the probes' page reader" deployment/line http://probes:8080/health blocked
expect "the line cannot reach the app" deployment/line http://website.website blocked
expect "the line cannot reach the node's ingress" deployment/line "https://$node_ip:443" blocked
expect "the line cannot reach a public address" deployment/line https://1.1.1.1 blocked
expect "the line cannot reach the gateway" deployment/line http://gateway:8080/health blocked
expect "the line cannot reach the host" deployment/line http://0.250.250.254:1234/v1/models blocked

# What a reader of telemetry may do: query each backend it reads through the proxy, and nothing else. A write the proxy
# refuses is answered 405, a path it does not pass 403, before it reaches a backend.
# $1: the reader; $2: its pod; $3: "tempo" if it reads Tempo as well as Prometheus and Loki.
reads_telemetry() {
  local q=http://query.telemetry
  expect "$1 queries Prometheus through the proxy" "$2" "$q:9090/api/v1/query?query=up" "reached, HTTP 200"
  expect "$1 queries Loki through the proxy" "$2" "$q:3100/loki/api/v1/query?query=vector(1)" "reached, HTTP 200"
  if [ "${3:-}" = tempo ]; then
    expect "$1 searches Tempo through the proxy" "$2" "$q:3200/api/search?limit=1" "reached, HTTP 200"
    expect "$1 cannot flush Tempo through the proxy" "$2" "$q:3200/flush" "reached, HTTP 403"
  else
    expect "$1 cannot reach Tempo through the proxy" "$2" "$q:3200/ready" blocked
  fi
  expect "$1 cannot write metrics through the proxy" "$2" "POST $q:9090/api/v1/otlp/v1/metrics" "reached, HTTP 405"
  expect "$1 cannot push logs through the proxy" "$2" "POST $q:3100/loki/api/v1/push" "reached, HTTP 405"
  expect "$1 cannot push OTLP logs through the proxy" "$2" "POST $q:3100/otlp/v1/logs" "reached, HTTP 405"
  expect "$1 cannot have Prometheus reload through the proxy" "$2" "POST $q:9090/-/reload" "reached, HTTP 405"
  expect "$1 cannot read Prometheus's configuration through the proxy" "$2" "$q:9090/api/v1/status/config" \
    "reached, HTTP 403"
  expect "$1 cannot reach Prometheus itself" "$2" http://prometheus-server.telemetry/-/healthy blocked
  expect "$1 cannot reach Loki itself" "$2" http://loki.telemetry:3100/ready blocked
  expect "$1 cannot reach Tempo itself" "$2" http://tempo.telemetry:3200/ready blocked
  expect "$1 cannot reach Tempo's intake" "$2" http://tempo.telemetry:4318/ blocked
  expect "$1 cannot reach Grafana" "$2" http://grafana.telemetry/api/health blocked
  for port in 9090 3100 3200; do
    expect "$1 cannot reach the stranger in telemetry on $port" "$2" "http://$stranger_ip:$port" blocked
  done
}

echo "The readers of telemetry, through the read-only proxy, and Prometheus itself:"
# The control: the stranger answers on each port, so a reader's "blocked" there is the policy's doing.
for port in 9090 3100 3200; do
  expect "the stranger in telemetry answers on $port" telemetry:egress-stranger "http://$stranger_ip:$port" reached
done
expect "Prometheus, asked directly, will not reload" telemetry:egress-stranger \
  "POST http://prometheus-server.telemetry/-/reload" "reached, HTTP 403"
reads_telemetry triage deployment/triage tempo
reads_telemetry "the intake" deployment/intake
reads_telemetry "the log watcher" deployment/logs tempo
reads_telemetry "the line" deployment/line tempo
expect "the worker cannot reach the proxy" "$pod" http://query.telemetry:9090/-/healthy blocked

echo "Pods labelled like a runner's agent pod and prepare pod:"
expect "the agent pod reaches the gateway" runners:egress-agent http://gateway.factory.svc:8080/health reached
expect "the agent pod reaches the handback" runners:egress-agent http://line.factory.svc:8081/health reached
expect "the agent pod cannot reach the line's step API" runners:egress-agent http://line.factory.svc:8080/health blocked
expect "the agent pod cannot look up a name" runners:egress-agent https://api.github.com "no name"
expect "the agent pod cannot reach a public address" runners:egress-agent https://1.1.1.1 blocked
expect "the agent pod cannot reach the Kubernetes API" runners:egress-agent "https://$api_ip/version" blocked
expect "the agent pod cannot reach the API server on the node" runners:egress-agent "https://$node_ip:6443" blocked
expect "the agent pod cannot reach the metadata address" runners:egress-agent http://169.254.169.254 blocked
expect "the agent pod cannot reach Postgres" runners:egress-agent "http://$postgres_ip:5432" blocked
expect "the agent pod cannot reach the console" runners:egress-agent "http://$console_ip" blocked
expect "the agent pod cannot reach the GitHub worker" runners:egress-agent "http://$github_ip:8080/health" blocked
expect "the agent pod cannot reach the app" runners:egress-agent "http://$website_ip" blocked
expect "the agent pod cannot reach the host" runners:egress-agent http://0.250.250.254:1234/v1/models blocked
expect "the prepare pod reaches GitHub" runners:egress-prepare https://api.github.com reached
expect "the prepare pod reaches the npm registry" runners:egress-prepare https://registry.npmjs.org reached
expect "the prepare pod cannot reach the gateway" runners:egress-prepare http://gateway.factory.svc:8080/health blocked
expect "the prepare pod cannot reach the host" runners:egress-prepare http://0.250.250.254:1234/v1/models blocked
expect "the prepare pod cannot reach the Kubernetes API" runners:egress-prepare "https://$api_ip/version" blocked
expect "the prepare pod cannot reach the metadata address" runners:egress-prepare http://169.254.169.254 blocked
expect "the prepare pod cannot reach Postgres" runners:egress-prepare "http://$postgres_ip:5432" blocked
expect "the prepare pod cannot reach the line's handback" runners:egress-prepare http://line.factory.svc:8081/health blocked

echo "The traffic generator, and a pod made like the canary's analysis Job (egress-journeys):"
expect "the traffic generator reaches Traefik" deployment/traffic http://traefik.kube-system reached
expect "the traffic generator cannot reach the app but through it" deployment/traffic http://website.website blocked
expect "the traffic generator cannot reach the canary but through it" deployment/traffic http://website-canary.website blocked
expect "the traffic generator cannot reach Postgres" deployment/traffic "http://$postgres_ip:5432" blocked
expect "the traffic generator cannot reach the gateway" deployment/traffic http://gateway:8080/health blocked
expect "the traffic generator cannot reach a public address" deployment/traffic https://1.1.1.1 blocked
expect "the analysis reaches the app" website:egress-journeys http://website.website reached
expect "the analysis reaches the canary" website:egress-journeys http://website-canary.website reached
expect "the analysis cannot reach Prometheus" website:egress-journeys http://prometheus-server.telemetry/-/healthy blocked
expect "the analysis cannot reach the collector" website:egress-journeys http://otel-collector.telemetry:4318 blocked
expect "the analysis cannot reach Postgres" website:egress-journeys "http://$postgres_ip:5432" blocked
expect "the analysis cannot reach the gateway" website:egress-journeys "http://$gateway_ip:8080/health" blocked
expect "the analysis cannot reach the Kubernetes API" website:egress-journeys "https://$api_ip/version" blocked
expect "the analysis cannot reach a public address" website:egress-journeys https://1.1.1.1 blocked

echo "A pod labelled like the app (egress-app), and who reaches the app:"
expect "the app reaches the collector, by its name" website:egress-app http://otel-collector.telemetry:4318 reached
expect "the app cannot reach the collector on another port" website:egress-app http://otel-collector.telemetry:4317 blocked
expect "the app cannot reach Prometheus" website:egress-app http://prometheus-server.telemetry/-/healthy blocked
expect "the app cannot reach Loki" website:egress-app http://loki.telemetry:3100/ready blocked
expect "the app cannot reach Tempo" website:egress-app http://tempo.telemetry:3200/ready blocked
expect "the app cannot reach the read-only proxy" website:egress-app http://query.telemetry:9090/-/healthy blocked
expect "the app cannot reach Postgres" website:egress-app "http://$postgres_ip:5432" blocked
expect "the app cannot reach the gateway" website:egress-app "http://$gateway_ip:8080/health" blocked
expect "the app cannot reach the Kubernetes API" website:egress-app "https://$api_ip/version" blocked
expect "the app cannot reach a public address" website:egress-app https://1.1.1.1 blocked
expect "Traefik passes a visitor to the app" deployment/traffic http://traefik.kube-system/health "reached, HTTP 200" \
  website.localhost
expect "the probes reach the app" factory:deployment/probes http://website.website/health "reached, HTTP 200"
expect "the probes reach the canary, for its pictures" factory:deployment/probes http://website-canary.website/health "reached, HTTP 200"
expect "the crawler reaches the app" factory:deployment/crawler http://website.website/health "reached, HTTP 200"
expect "a pod beside the app reaches the collector" website:egress-stranger http://otel-collector.telemetry:4318 reached
expect "a pod beside the app cannot reach it" website:egress-stranger http://website.website blocked

echo "A pod labelled like the Argo Rollouts controller (egress-rollouts):"
expect "the controller reaches the Kubernetes API" argo-rollouts:egress-rollouts "https://$api_ip/version" reached
expect "the controller reaches Prometheus" argo-rollouts:egress-rollouts http://prometheus-server.telemetry/-/healthy reached
expect "the controller cannot reach GitHub" argo-rollouts:egress-rollouts https://api.github.com blocked
expect "the controller cannot reach a public address" argo-rollouts:egress-rollouts https://1.1.1.1 blocked
expect "the controller cannot reach the app" argo-rollouts:egress-rollouts http://website.website blocked
expect "the controller cannot reach Loki" argo-rollouts:egress-rollouts http://loki.telemetry:3100/ready blocked
expect "the controller cannot reach Postgres" argo-rollouts:egress-rollouts "http://$postgres_ip:5432" blocked

echo "Pods labelled like Kyverno's admission controller (egress-admission) and its reports controller (egress-kyverno):"
expect "the admission controller reaches GHCR" kyverno:egress-admission https://ghcr.io/v2/ reached
expect "the admission controller reaches GHCR's storage" kyverno:egress-admission https://pkg-containers.githubusercontent.com reached
expect "the admission controller reaches Sigstore's trust root" kyverno:egress-admission https://tuf-repo-cdn.sigstore.dev/root.json reached
expect "the admission controller reaches the Kubernetes API" kyverno:egress-admission "https://$api_ip/version" reached
expect "the admission controller cannot leave on another port" kyverno:egress-admission http://1.1.1.1 blocked
expect "the admission controller cannot reach the app" kyverno:egress-admission http://website.website blocked
expect "the admission controller cannot reach Postgres" kyverno:egress-admission "http://$postgres_ip:5432" blocked
expect "the admission controller cannot reach the metadata address" kyverno:egress-admission http://169.254.169.254 blocked
expect "the admission controller cannot reach the host" kyverno:egress-admission http://0.250.250.254:1234/v1/models blocked
expect "the reports controller cannot reach GHCR" kyverno:egress-kyverno https://ghcr.io/v2/ blocked
expect "the reports controller cannot reach a public address" kyverno:egress-kyverno https://1.1.1.1 blocked
expect "the reports controller reaches the Kubernetes API" kyverno:egress-kyverno "https://$api_ip/version" reached

echo "The scoreboard:"
expect "the scoreboard reaches Postgres" scoreboard:deployment/scoreboard tcp://postgres.factory:5432 reached
expect "the scoreboard cannot reach the collector" scoreboard:deployment/scoreboard http://otel-collector.telemetry:4318 blocked
expect "the scoreboard cannot reach the gateway" scoreboard:deployment/scoreboard http://gateway.factory:8080/health blocked
expect "the scoreboard cannot reach the GitHub worker" scoreboard:deployment/scoreboard http://github.factory:8080/health blocked
expect "the scoreboard cannot reach the console" scoreboard:deployment/scoreboard http://console.factory blocked
expect "the scoreboard cannot reach the probes" scoreboard:deployment/scoreboard http://probes.factory:8080/health blocked
expect "the scoreboard cannot reach Prometheus" scoreboard:deployment/scoreboard http://prometheus-server.telemetry/-/healthy blocked
expect "the scoreboard cannot reach Loki" scoreboard:deployment/scoreboard http://loki.telemetry:3100/ready blocked
expect "the scoreboard cannot reach the read-only proxy" scoreboard:deployment/scoreboard http://query.telemetry:9090/-/healthy blocked
expect "the scoreboard cannot reach the app" scoreboard:deployment/scoreboard http://website.website blocked
expect "the scoreboard cannot reach the Kubernetes API" scoreboard:deployment/scoreboard "https://$api_ip/version" blocked
expect "the scoreboard cannot reach the API server on the node" scoreboard:deployment/scoreboard "https://$node_ip:6443" blocked
expect "the scoreboard cannot reach the host" scoreboard:deployment/scoreboard http://0.250.250.254:1234/v1/models blocked
expect "the scoreboard cannot reach the metadata address" scoreboard:deployment/scoreboard http://169.254.169.254 blocked
expect "the scoreboard cannot reach GitHub" scoreboard:deployment/scoreboard https://api.github.com blocked
expect "the scoreboard cannot reach a public address" scoreboard:deployment/scoreboard https://1.1.1.1 blocked

# Who may read the scoreboard's Secrets, or reach them another way: start a pod or a workload beside them that would
# mount them, change one that runs there, run a command in the scoreboard's pod or add a debug container to it, or
# give itself any of these rights (a role or binding there or cluster-wide, `bind` or `escalate`, impersonation). Every
# service account in the namespaces the factory, the app, the telemetry, Argo Rollouts and Kyverno run in is asked of
# the API server, the scoreboard's own included.
#
# Argo Rollouts' controller runs the app's canaries from a cluster-wide install, whose role reads Secrets everywhere,
# for its analyses' credentials, and makes and changes ReplicaSets, Jobs and pods' templates wherever a Rollout is. It
# keeps those rights, and only those: a pod it changed in `scoreboard` would still have to run the factory's own signed
# image (`scoreboard-images`). Argo CD's controllers, which deploy everything, and the cluster's own, in `kube-system`,
# may read every Secret, as they must; neither namespace runs anything of ours.
rights=(
  "get secrets" "list secrets" "watch secrets"
  "create pods" "patch pods" "update pods" "create pods/exec" "create pods/attach"
  "patch pods/ephemeralcontainers" "update pods/ephemeralcontainers"
)
for kind in deployments.apps replicasets.apps statefulsets.apps daemonsets.apps jobs.batch cronjobs.batch; do
  rights+=("create $kind" "patch $kind" "update $kind")
done
for kind in roles rolebindings clusterroles clusterrolebindings; do
  rights+=("create $kind.rbac.authorization.k8s.io" "patch $kind.rbac.authorization.k8s.io"
    "update $kind.rbac.authorization.k8s.io")
done
rights+=("bind roles.rbac.authorization.k8s.io" "escalate roles.rbac.authorization.k8s.io"
  "bind clusterroles.rbac.authorization.k8s.io" "escalate clusterroles.rbac.authorization.k8s.io"
  "impersonate serviceaccounts" "impersonate users" "impersonate groups")
rollouts_needs=" get secrets | list secrets | watch secrets | update pods | create replicasets.apps |
  patch replicasets.apps | update replicasets.apps | update deployments.apps | create jobs.batch | patch jobs.batch |
  update jobs.batch "
echo "The scoreboard's Secrets:"
asks=()
for ns in factory runners website scoreboard telemetry argo-rollouts kyverno; do
  for account in $(kubectl --context "$context" -n "$ns" get serviceaccounts -o jsonpath='{.items[*].metadata.name}'); do
    for right in "${rights[@]}"; do
      if [ "$ns/$account" = argo-rollouts/argo-rollouts ] && [[ "$rollouts_needs" == *" $right "* ]]; then continue; fi
      asks+=("$ns $account $right")
    done
  done
done
# Many questions, so several at once. `can-i` answers no with exit status 1, and fails otherwise: only its own answer
# counts, and anything but "no" is printed.
# A subresource is asked as one: given `pods/exec`, `can-i` would ask about a pod named `exec`.
answers=$(printf '%s\n' "${asks[@]}" | xargs -P 16 -L 1 bash -c '
  resource=${4%%/*} subresource=()
  if [ "$resource" != "$4" ]; then subresource=(--subresource "${4#*/}"); fi
  answer=$(kubectl --context "$0" -n scoreboard auth can-i "$3" "$resource" "${subresource[@]}" \
    --as "system:serviceaccount:$1:$2" 2>/dev/null) || true
  if [ "$answer" != no ]; then printf "  FAIL  %-62s %s\n" "$1/$2 may $3 $4 in scoreboard" "${answer:-no answer}"; fi
' "$context")
if [ -n "$answers" ]; then echo "$answers"; failed=1; else
  printf '  ok    %s\n' "no service account may reach them, and Argo Rollouts' controller only as its canaries need"
fi

if [ "$failed" = 0 ]; then
  echo "Only the gateway, the GitHub worker and Kyverno's admission controller leave the cluster; the readers of telemetry"
  echo "only query the backends; the runners, the release, the traffic, the app and the scoreboard are fenced."
else echo "The network policies do not hold."; fi
exit "$failed"
