#!/usr/bin/env bash
# Waits for Argo CD to have deployed everything: the end of `make up`, once every Application has synced.
#
# Everything root deploys must be healthy, its child Applications included, except the website. The website's health
# is its release's: Suspended while a canary pauses at a step, Degraded after a rollback until the next release starts.
# Either is the canary doing its job, not a deploy that failed, and root's health rolls the website's up, so waiting for
# root to be Healthy would wait out a release, and time out after a rollback. The website need only have settled:
# Healthy, Suspended or Degraded, not still coming up.
#
# KUBECTL is the kubectl command, with its context (the Makefile's). TIMEOUT is how long to wait, in seconds (default
# 600), and INTERVAL how often to look (default 5).
set -euo pipefail

read -r -a kubectl <<<"${KUBECTL:-kubectl --context k3d-software-factory}"
deadline=$((SECONDS + ${TIMEOUT:-600}))

while true; do
  # One line per resource root deploys, as kind/name=health; a kind with no health (a ConfigMap) has none.
  resources=$("${kubectl[@]}" -n argocd get application root \
    -o jsonpath='{range .status.resources[*]}{.kind}/{.name}={.health.status}{"\n"}{end}' 2>/dev/null || true)
  website=$(grep '^Application/website=' <<<"$resources" | cut -d= -f2 || true)
  waiting=$(grep -v -e '^Application/website=' -e '=$' -e '=Healthy$' <<<"$resources" || true)
  case "$website" in Healthy | Suspended | Degraded) settled=1 ;; *) settled= ;; esac

  if [[ -z "$waiting" && -n "$settled" ]]; then
    case "$website" in
      Suspended) echo "The website is Suspended: a release is in flight, at one of its canary's steps." ;;
      Degraded) echo "The website is Degraded: its last release was rolled back, or failed to start. Its Application in Argo CD says which." ;;
    esac
    exit 0
  fi
  if ((SECONDS >= deadline)); then
    echo "Argo CD hasn't deployed everything yet. Still waiting for:" >&2
    [[ -n "$waiting" ]] && sed 's/^/  /' <<<"$waiting" >&2
    [[ -z "$settled" ]] && echo "  Application/website=${website:-(not deployed)}" >&2
    exit 1
  fi
  sleep "${INTERVAL:-5}"
done
