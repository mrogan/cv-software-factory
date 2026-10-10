#!/usr/bin/env bash
# Whether admission control can enforce without stopping anything: `make admission-ready` (#173).
#
# Lists every image the guarded namespaces run or will start (their pods; the templates of their Deployments,
# StatefulSets, DaemonSets, Jobs and CronJobs; image volumes; and the runner image the line is pinned to), and checks
# each as the image policies do (deploy/base/admission): by digest; named in the namespace's policy, or ours on GHCR,
# signed by `build.yml` on `main` of the repository that builds it, with the SBOM it attested. Then it asks Kyverno: any
# pod its policy reports as failing is listed too. Exits non-zero if anything would be refused, so a policy goes from
# Audit to Deny only once every image its namespaces need is a signed digest.
#
# cosign is the same check the deploy pull requests make, but not Kyverno's own code, so an image cosign passes could
# still be one Kyverno refuses; Kyverno's reports cover the pods it has seen made since it was installed.
set -euo pipefail

context="${KUBE_CONTEXT:-k3d-software-factory}"
kubectl=(kubectl --context "$context")
command -v cosign >/dev/null || { echo "cosign isn't installed: run 'mise install'."; exit 1; }

issuer=https://token.actions.githubusercontent.com
identity() { echo "https://github.com/mrogan/$1/.github/workflows/build.yml@refs/heads/main"; }

# What a policy admits from another registry: the strings in its `allowed` variable.
allowed() {
  "${kubectl[@]}" get imagevalidatingpolicy "$1" -o json |
    jq -r '.spec.variables[] | select(.name == "allowed") | .expression' | { grep -o "'[^']*'" || true; } | tr -d "'"
}

# Every image a namespace names: running, in a template, in an image volume, or the line's RUNNER_IMAGE.
images() {
  "${kubectl[@]}" -n "$1" get pods,deployments,statefulsets,daemonsets,jobs,cronjobs -o json | jq -r '
    .items[] | (.spec.jobTemplate.spec.template.spec // .spec.template.spec // .spec) |
    (((.containers // []) + (.initContainers // []) + (.ephemeralContainers // []))[] |
      .image, (.env // [] | .[] | select(.name == "RUNNER_IMAGE") | .value)),
    ((.volumes // [])[] | .image.reference) | select(. != null)' | sort -u
}

failed=0
check() { # namespace policy allowed image
  local ns=$1 policy=$2 allowed=$3 image=$4 repo="" error
  if [[ ! "$image" =~ ^[^@]+@sha256:[0-9a-f]{64}$ ]]; then
    echo "  refused  $ns  $image: not by digest"; failed=1; return
  fi
  if grep -qxF "$image" <<<"$allowed"; then
    echo "  allowed  $ns  $image: named in $policy"; return
  fi
  case "$image" in
    ghcr.io/mrogan/cv-software-factory/*) repo=cv-software-factory ;;
    ghcr.io/mrogan/cv-worlds-worst-website@*) repo=cv-worlds-worst-website ;;
    *) echo "  refused  $ns  $image: from another registry"; failed=1; return ;;
  esac
  local trust=(--certificate-identity "$(identity "$repo")" --certificate-oidc-issuer "$issuer")
  if ! error=$(cosign verify "${trust[@]}" "$image" 2>&1 >/dev/null); then
    echo "  refused  $ns  $image: not signed by build.yml on main of $repo ($(tail -1 <<<"$error"))"; failed=1; return
  fi
  if ! error=$(cosign verify-attestation --type spdxjson "${trust[@]}" "$image" 2>&1 >/dev/null); then
    echo "  refused  $ns  $image: no SBOM attested by build.yml on main of $repo ($(tail -1 <<<"$error"))"
    failed=1; return
  fi
  echo "  signed   $ns  $image"
}

for pair in factory:factory-images runners:factory-images website:website-images; do
  ns=${pair%%:*} policy=${pair#*:}
  # Read first, so a cluster that cannot answer fails the script rather than checking nothing.
  allowed=$(allowed "$policy")
  list=$(images "$ns")
  for image in $list; do check "$ns" "$policy" "$allowed" "$image"; done
done

reports=$("${kubectl[@]}" get policyreports -A -o json | jq -r '
  .items[] | select(.metadata.namespace | IN("factory", "runners", "website")) | . as $report | .results[]? |
  select(.result == "fail" or .result == "error") |
  "  refused  \($report.metadata.namespace)  pod \($report.scope.name): \(.policy): \(.message)"')
if [ -n "$reports" ]; then
  echo "Kyverno reports:"; echo "$reports"; failed=1
fi

if [ "$failed" = 1 ]; then
  echo "Not ready: the images above would be refused. Keep the policies in Audit until their signed pins have merged."
  exit 1
fi
echo "Ready: every image the guarded namespaces run would be admitted. The policies can be switched to Deny."
