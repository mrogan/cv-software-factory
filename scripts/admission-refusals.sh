#!/usr/bin/env bash
# Asks the cluster to start, in each guarded namespace, a pod on an image the pipeline did not sign, one on an image
# signed by someone else and one on an image of ours that the namespace does not run, and keeps Kyverno's answers in
# deploy/test/admission-refusals.json, for milestone 7's red-team harness to show. Run it with every image policy
# enforcing (Deny), as `main` has them: not during a `try-the-line` run, which switches `factory-images` to Audit.
#
# Each request is a server-side dry run: it passes through admission exactly as a real one does, and nothing is made.
# The pods meet the restricted Pod Security Standard the namespaces enforce, so a refusal is the image policy's own.
#
#   unsigned        the factory's (or, in `website`, the app's) amd64 image from inside a build: build.yml signs the
#                   multi-platform index it pushes, not each platform's manifest in it, so this one is ours, on GHCR,
#                   by digest, and unsigned
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

# Signed builds: the factory's and its browser's from commit 22bcfa0, the app's from f68c10c.
factory=ghcr.io/the-roganator/cv-software-factory/factory@sha256:a717cec3e06dd4a0df6c6e7b945c4208807560fa03008149e7b096e8a134a667
website=ghcr.io/the-roganator/cv-worlds-worst-website@sha256:7ae8f3ef5a89017e77917ee68a4b62aae65c2e95d3d9f1f6b327a6d608927142
browser=ghcr.io/the-roganator/cv-software-factory/factory-browser@sha256:b05dba2a5e0ab0188a39e37f0cc23090d8af30430283f89b603407e52af2ab86
# The amd64 manifests inside the factory's build and the app's, which carry no signature of their own.
factory_unsigned=ghcr.io/the-roganator/cv-software-factory/factory@sha256:f8298adaffea60fac0d3238e3d6bf81dc918b78ab95a82f74b330ac4b3c6db9d
website_unsigned=ghcr.io/the-roganator/cv-worlds-worst-website@sha256:9d3c63c55c4307cdcc2f38f96b7006be274c353302e9ee0a3d2d8bdb13a152c8
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
      website) try "$ns" unsigned "$website_unsigned" ;;
      flagd) try "$ns" other-digest "$flagd" ;;
      *) try "$ns" unsigned "$factory_unsigned" ;;
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
