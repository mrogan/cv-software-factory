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

# $(call secret,namespace,name,data): create a Secret unless it exists.
secret = $(KUBECTL) create namespace $(1) --dry-run=client -o yaml | $(KUBECTL) apply -f - >/dev/null && \
	{ $(KUBECTL) -n $(1) get secret $(2) >/dev/null 2>&1 || $(KUBECTL) -n $(1) create secret generic $(2) $(3); }

.DEFAULT_GOAL := help
.PHONY: help up down check status e2e

help: ## List the targets
	@awk 'BEGIN { FS = ":.*## " } /^[a-z-]+:.*## / { printf "  \033[1m%-8s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

up: ## Create the local cluster; Argo CD then deploys everything from main (or REVISION=<branch>)
	@docker info >/dev/null 2>&1 || { echo "Docker isn't running. Start OrbStack (or another runtime) and try again."; exit 1; }
	@k3d cluster list $(CLUSTER) >/dev/null 2>&1 || k3d cluster create --config deploy/k3d/cluster.yaml
	helm upgrade --install argocd argo-cd --repo https://argoproj.github.io/argo-helm --version $(ARGOCD_CHART) \
		--kube-context $(CONTEXT) --namespace argocd --create-namespace \
		--values deploy/argocd/values.yaml --wait --timeout 5m --hide-notes
	@# Passwords live only in the cluster: made here once, never committed.
	@$(call secret,factory,postgres,--from-literal=password="$$(openssl rand -hex 24)")
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
	pnpm exec vitest run
	node docs/design/system/build.ts --check
	node packages/samples/src/export.ts --check
	pnpm --filter @software-factory/console build --logLevel warn
	node apps/console/scripts/budget.ts
	@# Argo CD renders each profile's overlay from main, so one that doesn't render must not get there.
	@for overlay in deploy/overlays/*/; do kustomize build $$overlay >/dev/null || exit 1; done

e2e: ## Run the console's browser tests in the pinned Playwright image; UPDATE=1 rewrites the snapshots
	docker run --rm --init --ipc=host -e UPDATE=$(UPDATE) -v "$(CURDIR):/src:ro" \
		-v "$(CURDIR)/apps/console/e2e/snapshots:/out/snapshots" -v "$(CURDIR)/apps/console/e2e-results:/out/results" \
		$(PLAYWRIGHT) /src/apps/console/e2e/in-docker.sh

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
