#!/usr/bin/env bash
# Runs the browser tests inside the pinned Playwright image (`make e2e`): the console's, so snapshots match from one
# machine to the next, and the probes'. The repository is mounted read-only at /src and copied, without the host's
# node_modules or build: this installs and builds its own. With UPDATE=1 the snapshots are rewritten and copied back
# to /out/snapshots, and only the console's tests run.
set -euo pipefail

mkdir -p /work
tar -C /src --exclude=./node_modules --exclude='*/node_modules' --exclude=./.git --exclude=./apps/console/dist -cf - . | tar -C /work -xf -
cd /work
corepack enable >/dev/null
pnpm install --frozen-lockfile --ignore-scripts --reporter=silent
pnpm --filter @software-factory/console build --logLevel warn
cd apps/console
export SF_PINNED_BROWSER=1
status=0
pnpm exec playwright test --project console ${UPDATE:+--update-snapshots} "$@" || status=$?
# The speed test on its own, once the others are done. Its usual dependency, the live test, needs a Postgres this
# image doesn't have.
if [ -z "${UPDATE:-}" ]; then
  pnpm exec playwright test --project speed --no-deps --output e2e-results/speed || status=$?
fi
# The probes, each against a small shop the tests make. They need Chromium, not the console or its snapshots.
if [ -z "${UPDATE:-}" ]; then
  (cd /work && pnpm exec vitest run --project browser) || status=$?
fi
if [ "$status" != 0 ] && [ -d /out/results ]; then cp -R e2e-results/. /out/results/; fi
if [ -n "${UPDATE:-}" ]; then
  rm -rf /out/snapshots/*
  cp -R e2e/snapshots/. /out/snapshots/
fi
exit $status
