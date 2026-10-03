#!/usr/bin/env bash
# Runs the console's browser tests inside the pinned Playwright image (`make e2e`), so snapshots match from one
# machine to the next. The repository is mounted read-only at /src and copied, so installing here never touches
# the host's node_modules. With UPDATE=1 the snapshots are rewritten and copied back to /out/snapshots.
set -euo pipefail

mkdir -p /work
tar -C /src --exclude=./node_modules --exclude='*/node_modules' --exclude=./.git -cf - . | tar -C /work -xf -
cd /work
corepack enable >/dev/null
pnpm install --frozen-lockfile --ignore-scripts --reporter=silent
pnpm --filter @software-factory/console build --logLevel warn
cd apps/console
status=0
pnpm exec playwright test --project console ${UPDATE:+--update-snapshots} "$@" || status=$?
if [ "$status" != 0 ] && [ -d /out/results ]; then cp -R e2e-results/. /out/results/; fi
if [ -n "${UPDATE:-}" ]; then
  rm -rf /out/snapshots/*
  cp -R e2e/snapshots/. /out/snapshots/
fi
exit $status
