#!/usr/bin/env bash
# Asks the cluster to start, in each guarded namespace, a pod on an image the pipeline did not sign, one on an image
# signed by someone else and one on an image of ours that the namespace does not run, and keeps Kyverno's answers in
# deploy/test/admission-refusals.json, for milestone 7's red-team harness to show. Run it with every image policy
# enforcing (Deny), as `main` has them: not during a `try-the-line` run, which switches `factory-images` to Audit.
#
# Each request is a server-side dry run: it passes through admission exactly as a real one does, and nothing is made.
# The pods meet the restricted Pod Security Standard the namespaces enforce, so a refusal is the image policy's own.
#
#   unsigned        the factory's (or, in `website`, the app's) image as build.yml pushed it before it signed images:
#                   ours, on GHCR, by digest, and unsigned
#   other-identity  Sigstore's timestamp server, signed keyless by its own release workflow
#                   (https://github.com/sigstore/timestamp-authority/.github/workflows/release.yaml@refs/tags/v2.1.0),
#                   and refused for its registry before its signature is looked at: only our GHCR's images are
#                   verified, against their own repository's identity
#   misplaced       ours, on GHCR, but not an image the namespace runs, so refused before its signature is looked
#                   at: in `website` the factory's own image (only its browser runs there), in `scoreboard` the
#                   factory's browser (only the factory's own image runs there), in `flagd` the factory's own (no
#                   image of ours runs there), elsewhere the app's
#   other-digest    in `flagd` alone, flagd's own image at an earlier release, by its digest: its copy admits the one
#                   digest it names, and no other from flagd's repository
#
# `flagd` has no `unsigned` case: no image of ours runs there, so one is refused as misplaced before its signature is
# looked at.
set -euo pipefail

context="${KUBE_CONTEXT:-k3d-software-factory}"
out="$(dirname "$0")/../deploy/test/admission-refusals.json"

factory=ghcr.io/mrogan/cv-software-factory/factory@sha256:96ab7beb79ac69cc54e1cb6e107d8979e51261573e82d4503b7a383ca1e3787f
website=ghcr.io/mrogan/cv-worlds-worst-website@sha256:8bc00e120b41cd55fe69e9a8c91d31882e57a3cfb01fc3e3a3060b34439dfe97
browser=ghcr.io/mrogan/cv-software-factory/factory-browser@sha256:92e361d5acc472f26afd99d4b55fd78586284cdfc1e6cbeb1253db420838f2f9
other=ghcr.io/sigstore/timestamp-server@sha256:8637f0482ed1ecb229b44ebd0afc760f6f57114a4d53c6953cf65c00218896b2
flagd=ghcr.io/open-feature/flagd:v0.16.3@sha256:a11ae82ec6e40e89edae4327392a1e4ffc03e211f1b724879bb35b2e4f271bb3

try() { # namespace case image: one JSON line, what was asked and what the cluster answered
  local ns=$1 kind=$2 image=$3 answer outcome
  if answer=$(kubectl --context "$context" -n "$ns" create --dry-run=server -o name -f - 2>&1 <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: admission-refusal
spec:
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: refused
      image: $image
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop: [ALL]
EOF
  ); then outcome=admitted; else outcome=refused; fi
  jq -cn --arg ns "$ns" --arg kind "$kind" --arg image "$image" --arg outcome "$outcome" --arg answer "$answer" \
    --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{namespace: $ns, case: $kind, image: $image, at: $at, outcome: $outcome,
      message: ($answer | sub("^Error from server: error when creating \"STDIN\": "; ""))}'
}

{
  for ns in factory runners website scoreboard flagd; do
    case "$ns" in
      website) try "$ns" unsigned "$website" ;;
      flagd) try "$ns" other-digest "$flagd" ;;
      *) try "$ns" unsigned "$factory" ;;
    esac
    try "$ns" other-identity "$other"
    case "$ns" in
      website | flagd) try "$ns" misplaced "$factory" ;;
      scoreboard) try "$ns" misplaced "$browser" ;;
      *) try "$ns" misplaced "$website" ;;
    esac
  done
} | jq -s . >"$out"
jq -r '.[] | "\(.outcome)  \(.namespace)  \(.case): \(.message)"' "$out"
