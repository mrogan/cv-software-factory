#!/usr/bin/env bash
# Whether admission control can be enforced without stopping anything: `make admission-ready`.
#
# Lists every image the guarded namespaces run or will start (their pods, the templates of their Deployments,
# StatefulSets and Jobs, and the runner image the line is pinned to), and checks each as the image policies do
# (deploy/base/admission): by digest; one the namespace's policy names, or ours on GHCR, signed by `build.yml` on `main`
# of the repository that builds it, with the SBOM it attested. Exits non-zero if any would be refused, so the policies
# go from Audit to Deny only once every pin is a signed digest.
#
# Checked with cosign, as the deploy pull requests' checks do, not by asking Kyverno: an image refused here would be
# refused there too, and this needs no change to the cluster.
set -euo pipefail

context="${KUBE_CONTEXT:-k3d-software-factory}"
kubectl=(kubectl --context "$context")
command -v cosign >/dev/null || { echo "cosign isn't installed: run 'mise install'."; exit 1; }

issuer=https://token.actions.githubusercontent.com
identity() { echo "https://github.com/mrogan/$1/.github/workflows/build.yml@refs/heads/main"; }

# What a namespace's policy admits from another registry: the strings in its `allowed` variable.
allowed() {
  "${kubectl[@]}" get imagevalidatingpolicy "$1" -o json |
    jq -r '.spec.variables[] | select(.name == "allowed") | .expression' | grep -o "'[^']*'" | tr -d "'" || true
}

# Every image a namespace names: running, or in a template, or the line's RUNNER_IMAGE.
images() {
  "${kubectl[@]}" -n "$1" get pods,deployments,statefulsets,jobs -o json | jq -r '
    .items[] | (.spec.template.spec // .spec) |
    ((.containers // []) + (.initContainers // []) + (.ephemeralContainers // []))[] |
    .image, (.env // [] | .[] | select(.name == "RUNNER_IMAGE") | .value)' | sort -u
}

failed=0
check() { # namespace policy image
  local ns=$1 policy=$2 image=$3 repo=""
  if [[ ! "$image" =~ ^[^@]+@sha256:[0-9a-f]{64}$ ]]; then
    echo "  refused  $ns  $image: not by digest"; failed=1; return
  fi
  if grep -qxF "$image" <<<"$(allowed "$policy")"; then
    echo "  allowed  $ns  $image: named in $policy"; return
  fi
  case "$image" in
    ghcr.io/mrogan/cv-software-factory/*) repo=cv-software-factory ;;
    ghcr.io/mrogan/cv-worlds-worst-website@*) repo=cv-worlds-worst-website ;;
    *) echo "  refused  $ns  $image: from another registry"; failed=1; return ;;
  esac
  local trust=(--certificate-identity "$(identity "$repo")" --certificate-oidc-issuer "$issuer")
  if ! cosign verify "${trust[@]}" "$image" >/dev/null 2>&1; then
    echo "  refused  $ns  $image: not signed by build.yml on main of $repo"; failed=1; return
  fi
  if ! cosign verify-attestation --type spdxjson "${trust[@]}" "$image" >/dev/null 2>&1; then
    echo "  refused  $ns  $image: no SBOM attested by build.yml on main of $repo"; failed=1; return
  fi
  echo "  signed   $ns  $image"
}

for pair in factory:factory-images runners:factory-images website:website-images; do
  ns=${pair%%:*} policy=${pair#*:}
  for image in $(images "$ns"); do check "$ns" "$policy" "$image"; done
done

if [ "$failed" = 1 ]; then
  echo "Not ready: the images above would be refused. Keep the policies in Audit until their signed pins have merged."
  exit 1
fi
echo "Ready: every image the guarded namespaces run would be admitted. The policies can be switched to Deny."
