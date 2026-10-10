#!/usr/bin/env bash
# Proves the network policies in deploy/base/factory: `make egress`.
#
# Only the gateway (TypeSafe, Anthropic) and the GitHub worker (GitHub and GHCR) may reach the internet, over TLS, and
# only triage and runners' agent pods may reach the gateway. This starts a pod labelled like a worker, which is what a
# compromised one would be, and shows that it cannot reach TypeSafe, GitHub, the gateway, the GitHub worker, the app or
# a public address, while the gateway can reach TypeSafe and the GitHub worker can reach GitHub.
#
# Then the line, which reaches the Kubernetes API and not another address on its port, nor the node's other ports.
#
# Then the runners (ADR 0008): a pod made like an agent pod (its labels, no DNS, the line's two addresses in its hosts)
# reaches the gateway and the line's handback and nothing else: not GitHub, the Kubernetes API, the cloud metadata
# address, Postgres, the console or the host, nor a name. A pod labelled like a prepare pod reaches GitHub and the npm
# registry, and none of the cluster.
#
# Then the release (milestone 6): the traffic generator reaches the shop only through Traefik, its front door; a pod
# made like the canary's analysis Job reaches the app's stable and canary Services and nothing else; a pod labelled
# like the Argo Rollouts controller reaches the Kubernetes API and Prometheus and not the internet; and in Kyverno's
# namespace, a pod labelled like the admission controller reaches GHCR and Sigstore's trust root, while one without
# that label reaches neither.
#
# Then the app's own pods, whose code agents write: a pod labelled like them reaches DNS and the collector, and not
# Prometheus, Loki, Tempo, Postgres, the gateway, the Kubernetes API or the internet. The app is reached through Traefik
# and by the probes, the crawler and the analysis, and not by another pod beside it.
#
# Every pod this starts runs an image the cluster already runs, pinned by digest, so nothing else is pulled and
# admission control lets it in: the workers' pod the factory image the gateway runs, the runners' pods and the ones in
# Kyverno's and Argo Rollouts' namespaces the runner image the line pins (Node is on its PATH), and the analysis Job's
# and the app's the `factory-browser` image the analysis pins. Each tries an address with Node's `fetch`, or, to name
# the shop's host to Traefik, with `http.get`.
#
# A check that must be blocked passes only when the connection is refused, reset, unreachable or never answered, as a
# policy blocks it: any other failure, such as a name that does not resolve, proves nothing about the fence.
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
cleanup() {
  # Each delete goes on whether the one before failed, so no probe pod is left behind.
  "${kubectl[@]}" delete pod "$pod" --ignore-not-found --wait=false >/dev/null || true
  "${runners[@]}" delete pod egress-agent egress-prepare --ignore-not-found --wait=false >/dev/null || true
  kubectl --context "$context" -n website delete pod egress-journeys egress-app egress-stranger --ignore-not-found \
    --wait=false >/dev/null || true
  kubectl --context "$context" -n argo-rollouts delete pod egress-rollouts --ignore-not-found --wait=false >/dev/null || true
  kubectl --context "$context" -n kyverno delete pod egress-admission egress-kyverno --ignore-not-found --wait=false >/dev/null || true
}
trap cleanup EXIT

# What a pod runs to try an address: prints the HTTP status, or why it could not connect. A server's certificate is
# not checked: the Kubernetes API's is the cluster's own, and reaching it at all is what counts. Given a host as well,
# it names that host over plain HTTP, as a visitor's browser does to Traefik; `fetch` will not send a Host header.
try='process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const blocks = ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "TimeoutError"];
const names = ["ENOTFOUND", "EAI_AGAIN"];
const [url, host] = process.argv.slice(1);
const get = host
  ? new Promise((resolve, reject) => {
      const req = require("node:http").get(url, { headers: { host }, timeout: 6000 }, (r) => {
        r.resume();
        resolve({ status: r.statusCode });
      });
      req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "TimeoutError" })));
      req.on("error", reject);
    })
  : fetch(url, { signal: AbortSignal.timeout(6000) });
get.then(
  (r) => console.log("reached, HTTP " + r.status),
  (e) => {
    const code = e.cause?.code ?? e.code ?? e.name;
    console.log((blocks.includes(code) ? "blocked: " : names.includes(code) ? "no name: " : "failed: ") + code);
  })'

# Starts a pod that idles, with the fences every namespace here enforces (the restricted standard).
# $1: namespace; $2: name; $3: image; $4: Node's path in it; $5: its labels, one per line; $6: more of its spec.
start_pod() {
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
      command: [$4, -e, "setTimeout(() => {}, 600000)"]
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
for started in factory/$pod runners/egress-agent runners/egress-prepare website/egress-journeys website/egress-app \
  website/egress-stranger argo-rollouts/egress-rollouts kyverno/egress-admission kyverno/egress-kyverno; do
  kubectl --context "$context" -n "${started%%/*}" wait "pod/${started#*/}" --for=condition=Ready --timeout=2m >/dev/null
done
# The policy reaches a new pod a moment after it starts.
sleep 5

failed=0
# $1: what is being tried; $2: where from (the pod); $3: the address; $4: blocked or reached, as it must be; $5: the
# host to name, if any.
expect() {
  local result
  local namespace=factory target=$2 node=/nodejs/bin/node
  # A target written <namespace>:<pod> runs the node on its PATH, which every image keeps but the factory image, whose
  # node is /nodejs/bin/node. So the probes and the crawler, on the browser image, are written factory:<pod> too.
  if [[ "$2" == *:* ]]; then namespace=${2%%:*} target=${2#*:} node=node; fi
  result=$(kubectl --context "$context" -n "$namespace" exec "$target" -- "$node" -e "$try" "$3" ${5:+"$5"} 2>/dev/null)
  if [[ "$result" == "$4"* ]]; then printf '  ok    %-62s %s\n' "$1" "$result"; else
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

echo "The line:"
expect "the line reaches the Kubernetes API" deployment/line "https://$api_ip/version" reached
expect "the line reaches the API server on the node" deployment/line "https://$node_ip:6443/version" reached
expect "the line cannot reach the node's ingress" deployment/line "https://$node_ip:443" blocked
expect "the line cannot reach a public address" deployment/line https://1.1.1.1 blocked
expect "the line cannot reach the gateway" deployment/line http://gateway:8080/health blocked
expect "the line cannot reach the host" deployment/line http://0.250.250.254:1234/v1/models blocked

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
expect "the app cannot reach Postgres" website:egress-app "http://$postgres_ip:5432" blocked
expect "the app cannot reach the gateway" website:egress-app "http://$gateway_ip:8080/health" blocked
expect "the app cannot reach the Kubernetes API" website:egress-app "https://$api_ip/version" blocked
expect "the app cannot reach a public address" website:egress-app https://1.1.1.1 blocked
expect "Traefik passes a visitor to the app" deployment/traffic http://traefik.kube-system/health "reached, HTTP 200" \
  website.localhost
expect "the probes reach the app" factory:deployment/probes http://website.website/health "reached, HTTP 200"
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

if [ "$failed" = 0 ]; then
  echo "Only the gateway, the GitHub worker and Kyverno's admission controller leave the cluster; the runners, the release,"
  echo "the traffic and the app are fenced."
else echo "The network policies do not hold."; fi
exit "$failed"
