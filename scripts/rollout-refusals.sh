#!/usr/bin/env bash
# Asks the cluster, as the admin service's service account, to patch the app's Rollout as its controls do and as they
# never may, and keeps the answers in deploy/test/rollout-refusals.json: what its Role
# (deploy/base/analysis/admin-controls-release.yaml) and the `website-rollout-controls` admission policy
# (deploy/base/admission/website/rollout-controls.yaml) let through. Run it with both on the cluster, as `main` has
# them, whenever either changes, with credentials that may impersonate a service account (Martin's own), and a few
# seconds after a change: the API server takes a moment to load a policy.
#
# Each request is a server-side dry run: it passes through authorisation and admission exactly as a real one does, and
# nothing is changed. Promote moves the status's step on by one, or to past the last step when it is there already, so a
# canary in flight or not, each asks the same of the policy.
#
#   pause             spec.paused set                                                  admitted
#   resume            spec.paused cleared                                              admitted
#   abort             status.abort set                                                 admitted
#   retry             status.abort cleared                                             admitted
#   promote           the status's step moved on, and its pauses cleared               admitted
#   promote-fully     status.promoteFull set                                           admitted
#   image             another image                                                    refused
#   steps             the canary's steps, straight to all of the traffic               refused
#   replicas          another number of replicas                                       refused
#   label             a label added                                                    refused
#   step-back         the status's step sent back by one                               refused
#   stable            the status's stable version changed                              refused
#   weights           the traffic split's weights in the status                        refused
#   pause-condition   a pause added                                                    refused
#   delete            the Rollout deleted                                              refused (by the Role)
#   traffic           the TraefikService's weights, directly                           refused (by the Role)
set -euo pipefail

context="${KUBE_CONTEXT:-k3d-software-factory}"
as=system:serviceaccount:factory:admin
out="$(dirname "$0")/../deploy/test/rollout-refusals.json"
kc() { kubectl --context "$context" --as "$as" -n website "$@"; }

at=$(kubectl --context "$context" -n website get rollout website -o jsonpath='{.status.currentStepIndex}')
at=${at:-0}
steps=$(kubectl --context "$context" -n website get rollout website -o json | jq '.spec.strategy.canary.steps | length')
step=$(( at < steps ? at + 1 : steps ))

record() { # case outcome answer: one JSON line
  jq -cn --arg kind "$1" --arg outcome "$2" --arg answer "$3" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{case: $kind, at: $at, outcome: $outcome, message: ($answer | sub("^Error from server[^:]*: "; ""))}'
}

try() { # case subresource patch
  local kind=$1 subresource=$2 patch=$3 answer extra=()
  [[ -n $subresource ]] && extra=(--subresource "$subresource")
  if answer=$(kc patch rollout website --type merge -p "$patch" --dry-run=server -o name ${extra[@]+"${extra[@]}"} 2>&1); then
    record "$kind" admitted "$answer"
  else
    record "$kind" refused "$answer"
  fi
}

{
  try pause '' '{"spec":{"paused":true}}'
  try resume '' '{"spec":{"paused":false}}'
  try abort status '{"status":{"abort":true}}'
  try retry status '{"status":{"abort":false}}'
  try promote status "{\"status\":{\"pauseConditions\":null,\"controllerPause\":false,\"currentStepIndex\":$step}}"
  try promote-fully status '{"status":{"promoteFull":true}}'
  try image '' '{"spec":{"template":{"spec":{"containers":[{"name":"website","image":"nginx"}]}}}}'
  try steps '' '{"spec":{"strategy":{"canary":{"steps":[{"setWeight":100}]}}}}'
  try replicas '' '{"spec":{"replicas":5}}'
  try label '' '{"metadata":{"labels":{"rollout-refusal":"x"}}}'
  try step-back status "{\"status\":{\"currentStepIndex\":$(( at - 1 ))}}"
  try stable status '{"status":{"stableRS":"rollout-refusal"}}'
  try weights status '{"status":{"canary":{"weights":{"canary":{"weight":100,"podTemplateHash":"x","serviceName":"website-canary"},"stable":{"weight":0,"podTemplateHash":"x","serviceName":"website"}}}}}'
  try pause-condition status '{"status":{"pauseConditions":[{"reason":"PausedByUser","startTime":"2026-01-01T00:00:00Z"}]}}'
  if answer=$(kc delete rollout website --dry-run=server 2>&1); then record delete admitted "$answer"; else record delete refused "$answer"; fi
  if answer=$(kc patch traefikservice website --type merge -p '{"spec":{"weighted":{"services":[]}}}' --dry-run=server -o name 2>&1); then
    record traffic admitted "$answer"
  else
    record traffic refused "$answer"
  fi
} | jq -s . >"$out"
jq -r '.[] | "\(.outcome)  \(.case): \(.message)"' "$out"
