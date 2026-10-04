# One entry point for the factory. `make` on its own lists the targets.

CLUSTER := software-factory
CONTEXT := k3d-$(CLUSTER)
KUBECTL := kubectl --context $(CONTEXT)
ARGOCD_CHART := 10.9.5
# The browser tests run in this image, so their snapshots match wherever they run.
PLAYWRIGHT := mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
# The branch Argo CD deploys this repository's deploy/ from. `make up REVISION=my-branch` tries a change there
# before it merges; the charts' values and the app's repository are still read from main.
REVISION ?= main

# $(call as-writer,command): run a command on the host as the factory's writer, through a port-forward to Postgres.
as-writer = $(KUBECTL) -n factory port-forward svc/postgres 15432:5432 >/dev/null 2>&1 & forward=$$!; \
	trap 'kill $$forward' EXIT; sleep 2; \
	PGHOST=127.0.0.1 PGPORT=15432 PGDATABASE=factory PGUSER=factory_writer \
	PGPASSWORD="$$($(KUBECTL) -n factory get secret postgres-writer -o jsonpath='{.data.password}' | base64 -d)" $(1)

# $(call secret,namespace,name,data): create a Secret unless it exists.
secret = $(KUBECTL) create namespace $(1) --dry-run=client -o yaml | $(KUBECTL) apply -f - >/dev/null && \
	{ $(KUBECTL) -n $(1) get secret $(2) >/dev/null 2>&1 || $(KUBECTL) -n $(1) create secret generic $(2) $(3); }

.DEFAULT_GOAL := help
.PHONY: help up down check status e2e eval samples real-store stop-the-line start-the-line

help: ## List the targets
	@awk 'BEGIN { FS = ":.*## " } /^[a-z0-9-]+:.*## / { printf "  \033[1m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

up: ## Create the local cluster; Argo CD then deploys everything from main (or REVISION=<branch>)
	@docker info >/dev/null 2>&1 || { echo "Docker isn't running. Start OrbStack (or another runtime) and try again."; exit 1; }
	@k3d cluster list $(CLUSTER) >/dev/null 2>&1 || k3d cluster create --config deploy/k3d/cluster.yaml
	helm upgrade --install argocd argo-cd --repo https://argoproj.github.io/argo-helm --version $(ARGOCD_CHART) \
		--kube-context $(CONTEXT) --namespace argocd --create-namespace \
		--values deploy/argocd/values.yaml --wait --timeout 5m --hide-notes
	@# Passwords live only in the cluster: made here once, never committed.
	@$(call secret,factory,postgres,--from-literal=password="$$(openssl rand -hex 24)")
	@$(call secret,factory,postgres-writer,--from-literal=password="$$(openssl rand -hex 24)")
	@$(call secret,factory,postgres-console,--from-literal=password="$$(openssl rand -hex 24)")
	@$(call secret,telemetry,grafana-admin,--from-literal=admin-user=admin --from-literal=admin-password="$$(openssl rand -hex 24)")
	sed 's|targetRevision: main|targetRevision: $(REVISION)|' deploy/argocd/root.yaml | $(KUBECTL) apply -f -
	@echo "Waiting for Argo CD to deploy everything (a few minutes the first time)..."
	@# An Application reads healthy before it has deployed anything, so wait for each to sync before its health.
	@# Root syncs first: then every other Application exists.
	@$(KUBECTL) -n argocd wait application/root --for=jsonpath='{.status.sync.status}'=Synced --timeout=5m >/dev/null
	@$(KUBECTL) -n argocd wait applications --all --for=jsonpath='{.status.sync.status}'=Synced --timeout=5m >/dev/null
	@$(KUBECTL) -n argocd wait applications --all --for=jsonpath='{.status.health.status}'=Healthy --timeout=10m >/dev/null
	@$(MAKE) --no-print-directory status

down: ## Delete the local cluster, and everything in it
	k3d cluster delete $(CLUSTER)

check: ## Lint, type-check, test, build the browser code, check generated files are current, render the manifests
	pnpm exec biome ci
	pnpm exec tsc
	pnpm exec tsc -p apps/console/web
	pnpm exec tsc -p apps/console/e2e
	pnpm exec vitest run --project unit --project database
	node docs/design/system/build.ts --check
	node packages/samples/src/export.ts --check
	node apps/factory/src/alerts/rules.ts --check
	pnpm --filter @software-factory/console build --logLevel warn
	node apps/console/scripts/budget.ts
	@# Argo CD renders each profile's overlay from main, so one that doesn't render must not get there.
	@for overlay in deploy/overlays/*/; do kustomize build $$overlay >/dev/null || exit 1; done

e2e: ## Run the browser tests (the console's, and the probes') in the pinned Playwright image; UPDATE=1 rewrites the snapshots
	docker run --rm --init --ipc=host -e UPDATE=$(UPDATE) -v "$(CURDIR):/src:ro" \
		-v "$(CURDIR)/apps/console/e2e/snapshots:/out/snapshots" -v "$(CURDIR)/apps/console/e2e-results:/out/results" \
		$(PLAYWRIGHT) /src/apps/console/e2e/in-docker.sh

eval: node_modules ## Run triage's evaluation set against Jev live, recording its cassettes; RUNS=3 shows the drift
	@TYPESAFE_API_KEY="$${TYPESAFE_API_KEY:-$$(security find-generic-password -s typesafe-api-key -w 2>/dev/null)}" \
		node apps/factory/scripts/eval.ts --runs $(or $(RUNS),1)

samples: node_modules ## Load the sample work items into the cluster's store, with their times moved so the last is now
	@# Screenshots first, into the artifacts volume, through a pod that mounts it for a moment (and not one still
	@# going from an earlier run).
	@$(KUBECTL) -n factory delete pod artifacts-copier --ignore-not-found --wait >/dev/null
	@$(KUBECTL) apply -f deploy/k3d/artifacts-copier.yaml >/dev/null
	@$(KUBECTL) -n factory wait pod/artifacts-copier --for=condition=Ready --timeout=2m >/dev/null
	@# No macOS metadata files in the archive (COPYFILE_DISABLE); Linux ignores the setting.
	@COPYFILE_DISABLE=1 tar -C packages/samples/log/artifacts -cf - . | \
		$(KUBECTL) -n factory exec -i artifacts-copier -- tar -C /var/lib/factory/artifacts -xf -
	@$(KUBECTL) -n factory delete pod artifacts-copier --wait=false >/dev/null
	@# Then the events, as the factory's writer, through a port-forward to Postgres.
	@$(call as-writer,ARTIFACTS_DIR=packages/samples/log/artifacts node apps/factory/src/cli.ts events load packages/samples/log)
	@echo "  Console  http://console.localhost:8080"

real-store: node_modules ## Replace the cluster's store with an empty one for real events (FORCE=1 if it holds some)
	@# As the database's owner, through a port-forward: only the owner may drop the schema.
	@$(KUBECTL) -n factory port-forward svc/postgres 15432:5432 >/dev/null 2>&1 & forward=$$!; \
		trap 'kill $$forward' EXIT; sleep 2; \
		PGHOST=127.0.0.1 PGPORT=15432 PGDATABASE=factory PGUSER=factory \
		PGPASSWORD="$$($(KUBECTL) -n factory get secret postgres -o jsonpath='{.data.password}' | base64 -d)" \
		node packages/store/src/real-store.ts $(if $(FORCE),--force)
	@# The samples' screenshots go too, and the console starts again from an empty history.
	@$(KUBECTL) -n factory delete pod artifacts-copier --ignore-not-found --wait >/dev/null
	@$(KUBECTL) apply -f deploy/k3d/artifacts-copier.yaml >/dev/null
	@$(KUBECTL) -n factory wait pod/artifacts-copier --for=condition=Ready --timeout=2m >/dev/null
	@$(KUBECTL) -n factory exec artifacts-copier -- find /var/lib/factory/artifacts -mindepth 1 -delete
	@$(KUBECTL) -n factory delete pod artifacts-copier --wait=false >/dev/null
	@$(KUBECTL) -n factory rollout restart deployment/console >/dev/null
	@echo "  Console  http://console.localhost:8080"

stop-the-line: node_modules ## Stop the line: workers finish what they hold and take nothing new (REASON="...")
	@$(call as-writer,node apps/factory/src/cli.ts line stop $(if $(REASON),--reason "$(REASON)"))

start-the-line: node_modules ## Start the line again; workers take what waited in the inbox
	@$(call as-writer,node apps/factory/src/cli.ts line start)

# The factory command runs on the host, so loading the samples needs the dependencies: installed on first use, and
# again when the lockfile changes.
node_modules: pnpm-lock.yaml
	pnpm install --frozen-lockfile
	@touch node_modules

status: ## Show what is running, and where to open it
	@if ! k3d cluster list $(CLUSTER) >/dev/null 2>&1; then echo "No cluster. Run 'make up'."; else \
		$(KUBECTL) -n argocd get applications -o custom-columns='APPLICATION:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status'; \
		echo; \
		echo "  Deployed from $$($(KUBECTL) -n argocd get application root -o jsonpath='{.spec.source.targetRevision}') at $$($(KUBECTL) -n argocd get application root -o jsonpath='{.status.sync.revision}' | cut -c1-7)"; \
		echo "  Console  http://console.localhost:8080   $$(curl -sf http://console.localhost:8080/version || echo '(not up yet)')"; \
		echo "  Website  http://website.localhost:8080   $$(curl -sf http://website.localhost:8080/version || echo '(not up yet)')"; \
		echo "  Grafana  http://grafana.localhost:8080"; \
		echo "  Argo CD  http://argocd.localhost:8080    read-only; the admin password is in the argocd-initial-admin-secret Secret"; \
	fi
