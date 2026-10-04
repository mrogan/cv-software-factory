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
# registry, and none of the cluster. The workers' pod runs the factory image the gateway runs, and the runners' pods
# the runner image the line pins, each with Node's `fetch`, so nothing else is pulled.
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
runners=(kubectl --context "$context" -n runners)
cleanup() {
  "${kubectl[@]}" delete pod "$pod" --ignore-not-found --wait=false >/dev/null
  "${runners[@]}" delete pod egress-agent egress-prepare --ignore-not-found --wait=false >/dev/null
}
trap cleanup EXIT
"${kubectl[@]}" delete pod "$pod" --ignore-not-found --wait >/dev/null

# What a pod runs to try an address: prints the HTTP status, or why it could not connect. A server's certificate is
# not checked: the Kubernetes API's is the cluster's own, and reaching it at all is what counts.
try='process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const blocks = ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "TimeoutError"];
const names = ["ENOTFOUND", "EAI_AGAIN"];
fetch(process.argv[1], { signal: AbortSignal.timeout(6000) }).then(
  (r) => console.log("reached, HTTP " + r.status),
  (e) => {
    const code = e.cause?.code ?? e.name;
    console.log((blocks.includes(code) ? "blocked: " : names.includes(code) ? "no name: " : "failed: ") + code);
  })'

# A worker's labels and the same fences the workers have (the namespace enforces the restricted standard).
"${kubectl[@]}" apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $pod
  labels:
    app.kubernetes.io/name: intruder
    app.kubernetes.io/part-of: software-factory
    app.kubernetes.io/component: worker
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: intruder
      image: $image
      command: [/nodejs/bin/node, -e, "setTimeout(() => {}, 120000)"]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: [ALL]
EOF
"${kubectl[@]}" wait "pod/$pod" --for=condition=Ready --timeout=2m >/dev/null

failed=0
# $1: what is being tried; $2: where from (the pod); $3: the address; $4: blocked or reached, as it must be.
expect() {
  local result
  local namespace=factory target=$2 node=/nodejs/bin/node
  # A target in another namespace is written <namespace>:<pod>; the runner image keeps node on the PATH.
  if [[ "$2" == *:* ]]; then namespace=${2%%:*} target=${2#*:} node=node; fi
  result=$(kubectl --context "$context" -n "$namespace" exec "$target" -- "$node" -e "$try" "$3" 2>/dev/null)
  if [[ "$result" == "$4"* ]]; then printf '  ok    %-52s %s\n' "$1" "$result"; else
    printf '  FAIL  %-52s %s (wanted %s)\n' "$1" "$result" "$4"
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

# Addresses, for the agent pod, which has no DNS, and for the checks of the node's own ports.
ip() { kubectl --context "$context" -n "$1" get service "$2" -o jsonpath='{.spec.clusterIP}'; }
gateway_ip=$(ip factory gateway) line_ip=$(ip factory line) github_ip=$(ip factory github)
api_ip=$(ip default kubernetes) postgres_ip=$(ip factory postgres) console_ip=$(ip factory console)
website_ip=$(ip website website)
node_ip=$(kubectl --context "$context" get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')

echo "The line:"
expect "the line reaches the Kubernetes API" deployment/line "https://$api_ip/version" reached
expect "the line reaches the API server on the node" deployment/line "https://$node_ip:6443/version" reached
expect "the line cannot reach the node's ingress" deployment/line "https://$node_ip:443" blocked
expect "the line cannot reach a public address" deployment/line https://1.1.1.1 blocked
expect "the line cannot reach the gateway" deployment/line http://gateway:8080/health blocked
expect "the line cannot reach the host" deployment/line http://0.250.250.254:1234/v1/models blocked

# Pods labelled like a runner's two pods, in `runners`, with the restricted standard the namespace enforces.
# $3, for an agent pod: what the line writes into its pod spec, no DNS and the two addresses it needs.
runner_pod() {
  "${runners[@]}" delete pod "$1" --ignore-not-found --wait >/dev/null
  "${runners[@]}" apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $1
  labels:
    app.kubernetes.io/part-of: software-factory
    factory.mrogan.dev/runner: $2
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
${3:-}
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: $1
      image: $runner_image
      command: [node, -e, "setTimeout(() => {}, 120000)"]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: [ALL]
EOF
  "${runners[@]}" wait "pod/$1" --for=condition=Ready --timeout=2m >/dev/null
}
runner_pod egress-agent agent "  dnsPolicy: None
  dnsConfig:
    nameservers: [127.0.0.1]
  hostAliases:
    - { ip: $gateway_ip, hostnames: [gateway.factory.svc] }
    - { ip: $line_ip, hostnames: [line.factory.svc] }"
runner_pod egress-prepare prepare
# The policy reaches a new pod a moment after it starts.
sleep 5

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

if [ "$failed" = 0 ]; then echo "Only the gateway and the GitHub worker leave the cluster, and the runners are fenced."; else echo "The network policies do not hold."; fi
exit "$failed"
