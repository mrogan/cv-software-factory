#!/usr/bin/env bash
# Proves the network policies in deploy/base/factory: `make egress`.
#
# Only the gateway may reach the internet (TypeSafe, over TLS), and only triage may reach the gateway. This starts a
# pod labelled like a worker, which is what a compromised one would be, and shows that it cannot reach TypeSafe, the
# gateway, the app or a public address, while the gateway can reach TypeSafe. It runs the factory image the gateway
# runs, with Node's `fetch`, so nothing else is pulled.
#
# The control matters: if the gateway could not reach TypeSafe either, the pod's failure would prove only that the
# network was down.
set -euo pipefail

context="${KUBE_CONTEXT:-k3d-software-factory}"
kubectl=(kubectl --context "$context" -n factory)
pod=egress-intruder

image=$("${kubectl[@]}" get deployment gateway -o jsonpath='{.spec.template.spec.containers[0].image}')
trap '"${kubectl[@]}" delete pod "$pod" --ignore-not-found --wait=false >/dev/null' EXIT
"${kubectl[@]}" delete pod "$pod" --ignore-not-found --wait >/dev/null

# What a pod runs to try an address: prints the HTTP status, or why it could not connect.
try='fetch(process.argv[1], { signal: AbortSignal.timeout(6000) }).then(
  (r) => console.log("reached, HTTP " + r.status),
  (e) => console.log("blocked: " + (e.cause?.code ?? e.name)))'

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
  result=$("${kubectl[@]}" exec "$2" -- /nodejs/bin/node -e "$try" "$3")
  if [[ "$result" == "$4"* ]]; then printf '  ok    %-52s %s\n' "$1" "$result"; else
    printf '  FAIL  %-52s %s (wanted %s)\n' "$1" "$result" "$4"
    failed=1
  fi
}

echo "A pod labelled like a worker (${pod}), and the gateway:"
expect "the gateway reaches TypeSafe" deployment/gateway https://api.typesafe.ai reached
expect "the worker cannot reach TypeSafe" "$pod" https://api.typesafe.ai blocked
expect "the worker cannot reach a public address" "$pod" https://1.1.1.1 blocked
expect "the worker cannot reach the gateway" "$pod" http://gateway:8080/health blocked
expect "the worker cannot reach the app" "$pod" http://website.website blocked
expect "the worker cannot reach Prometheus" "$pod" http://prometheus-server.telemetry/-/healthy blocked
expect "the gateway cannot reach the app" deployment/gateway http://website.website blocked
expect "triage reaches the gateway" deployment/triage http://gateway:8080/health reached
expect "the intake cannot reach the gateway" deployment/intake http://gateway:8080/health blocked

if [ "$failed" = 0 ]; then echo "Only the gateway leaves the cluster."; else echo "The network policies do not hold."; fi
exit "$failed"
