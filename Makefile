# One entry point for the factory. `make` on its own lists the targets.

CLUSTER := software-factory
CONTEXT := k3d-$(CLUSTER)
KUBECTL := kubectl --context $(CONTEXT)
ARGOCD_CHART := 10.9.5
# The browser tests run in this image, so their snapshots match wherever they run. Its one pin is Dockerfile.browser's.
PLAYWRIGHT := $(shell grep -oE 'mcr\.microsoft\.com/playwright:[^ ]+' apps/factory/Dockerfile.browser)
# The branch Argo CD deploys this repository's deploy/ from. `make up REVISION=my-branch` tries a change there
# before it merges; the charts' values and the app's repository are still read from main.
REVISION ?= main
# The private checkout, which holds the answer key: `make up` gives the scoreboard each entry's id and fingerprint.
PRIVATE_DIR ?= $(CURDIR)/../cv-software-factory-private
# The workers that connect to the store, each as a role of its own (packages/store/migrations/0022_worker-roles.sql).
STORE_WORKERS := triage line gateway probes crawler intake logs
# The local certificate authority behind the console's HTTPS, outside the repository (scripts/local-ca.ts).
LOCAL_CA = $(shell node scripts/local-ca.ts dir)

# $(call as-writer,command): run a command on the host as the factory's writer, through a port-forward to Postgres.
as-writer = $(KUBECTL) -n factory port-forward svc/postgres 15432:5432 >/dev/null 2>&1 & forward=$$!; \
	trap 'kill $$forward' EXIT; sleep 2; \
	PGHOST=127.0.0.1 PGPORT=15432 PGDATABASE=factory PGUSER=factory_writer \
	PGPASSWORD="$$($(KUBECTL) -n factory get secret postgres-writer -o jsonpath='{.data.password}' | base64 -d)" $(1)

# $(call secret,namespace,name,data): create a Secret unless it exists.
secret = $(KUBECTL) create namespace $(1) --dry-run=client -o yaml | $(KUBECTL) apply -f - >/dev/null && \
	{ $(KUBECTL) -n $(1) get secret $(2) >/dev/null 2>&1 || $(KUBECTL) -n $(1) create secret generic $(2) $(3); }

.DEFAULT_GOAL := help
.PHONY: help up down gateway-key github-key scoreboard-secrets worker-secrets check status e2e egress admission-ready eval samples real-store stop-the-line start-the-line

help: ## List the targets
	@awk 'BEGIN { FS = ":.*## " } /^[a-z0-9-]+:.*## / { printf "  \033[1m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

up: ## Create the local cluster; Argo CD then deploys everything from main (or REVISION=<branch>)
	@docker info >/dev/null 2>&1 || { echo "Docker isn't running. Start OrbStack (or another runtime) and try again."; exit 1; }
	@k3d cluster list $(CLUSTER) >/dev/null 2>&1 || k3d cluster create --config deploy/k3d/cluster.yaml
	@# A cluster made before the console moved to HTTPS has no 8443. k3d adds it in place by making the cluster's load
	@# balancer again, and keeps everything in the cluster, the store included.
	@docker port k3d-$(CLUSTER)-serverlb 443/tcp >/dev/null 2>&1 || { \
		echo "  This cluster has no HTTPS port: adding 127.0.0.1:8443, which restarts its load balancer and nothing else."; \
		k3d cluster edit $(CLUSTER) --port-add 127.0.0.1:8443:443@loadbalancer; }
	helm upgrade --install argocd argo-cd --repo https://argoproj.github.io/argo-helm --version $(ARGOCD_CHART) \
		--kube-context $(CONTEXT) --namespace argocd --create-namespace \
		--values deploy/argocd/values.yaml --wait --timeout 5m --hide-notes
	@# Passwords live only in the cluster: made here once, never committed.
	@$(call secret,factory,postgres,--from-literal=password="$$(openssl rand -hex 24)")
	@$(call secret,factory,postgres-writer,--from-literal=password="$$(openssl rand -hex 24)")
	@$(call secret,factory,postgres-console,--from-literal=password="$$(openssl rand -hex 24)")
	@$(call secret,factory,postgres-metrics,--from-literal=password="$$(openssl rand -hex 24)")
	@$(MAKE) --no-print-directory worker-secrets
	@$(MAKE) --no-print-directory gateway-key
	@$(MAKE) --no-print-directory github-key
	@$(MAKE) --no-print-directory scoreboard-secrets
	@$(call secret,telemetry,grafana-admin,--from-literal=admin-user=admin --from-literal=admin-password="$$(openssl rand -hex 24)")
	@$(MAKE) --no-print-directory local-tls
	sed 's|targetRevision: main|targetRevision: $(REVISION)|' deploy/argocd/root.yaml | $(KUBECTL) apply -f -
	@echo "Waiting for Argo CD to deploy everything (a few minutes the first time)..."
	@# An Application reads healthy before it has deployed anything, so wait for each to sync before its health.
	@# Root syncs first: then every other Application exists.
	@$(KUBECTL) -n argocd wait application/root --for=jsonpath='{.status.sync.status}'=Synced --timeout=5m >/dev/null
	@$(KUBECTL) -n argocd wait applications --all --for=jsonpath='{.status.sync.status}'=Synced --timeout=5m >/dev/null
	@# Then everything healthy, except the website, whose health is its release's (scripts/wait-deployed.sh).
	@KUBECTL="$(KUBECTL)" scripts/wait-deployed.sh
	@$(MAKE) --no-print-directory status

down: ## Delete the local cluster, and everything in it
	k3d cluster delete $(CLUSTER)
	@echo "  The local certificate authority stays, trusted, for the next 'make up'. 'make untrust-ca' removes it."

.PHONY: local-tls untrust-ca

# The console's HTTPS: a local certificate authority that may sign for `localhost` names only, made once and kept
# outside the repository; the Mac's trust in it, for TLS servers only, asked for once; and its certificate for the
# console, renewed in its last 30 days, in the Secret Traefik serves it from. Declining the trust prompt leaves the
# console behind a browser warning, and the admin sign-in unusable, until the next `make up` asks again.
local-tls: ## Make the console's certificate (and its local authority) if due, have the Mac trust it, and give it to Traefik
	@node scripts/local-ca.ts issue
	@node scripts/local-ca.ts trust
	@$(KUBECTL) create namespace factory --dry-run=client -o yaml | $(KUBECTL) apply -f - >/dev/null
	@$(KUBECTL) -n factory create secret tls console-tls --cert="$(LOCAL_CA)/tls.crt" --key="$(LOCAL_CA)/tls.key" \
		--dry-run=client -o yaml | $(KUBECTL) apply -f - >/dev/null

untrust-ca: ## Stop the Mac trusting the local certificate authority, and delete it; the next `make up` makes another
	@node scripts/local-ca.ts untrust

# The gateway's keys, TypeSafe's and Anthropic's, from the environment or the macOS Keychain, go to the cluster and
# nowhere else: each is piped through stdin, never written to a file or put on a command line. Without one there is no
# Secret, and the gateway replays that provider's cassettes only. Restart the gateway after changing a key: it reads
# them when it starts.
gateway-key:
	@key="$${TYPESAFE_API_KEY:-$$(security find-generic-password -s typesafe-api-key -w 2>/dev/null)}"; \
		if [ -n "$$key" ]; then \
			printf %s "$$key" | $(KUBECTL) -n factory create secret generic typesafe --from-file=api-key=/dev/stdin --dry-run=client -o yaml | \
				$(KUBECTL) apply -f - >/dev/null && echo "  The gateway has the TypeSafe key, so it records what Jev answers."; \
		else echo "  No TypeSafe key (TYPESAFE_API_KEY, or the Keychain's typesafe-api-key): the gateway replays cassettes only."; fi
	@key="$${ANTHROPIC_API_KEY:-$$(security find-generic-password -s anthropic-api-key -w 2>/dev/null)}"; \
		if [ -n "$$key" ]; then \
			printf %s "$$key" | $(KUBECTL) -n factory create secret generic anthropic --from-file=api-key=/dev/stdin --dry-run=client -o yaml | \
				$(KUBECTL) apply -f - >/dev/null && echo "  The gateway has the Anthropic key, so agents' calls reach Claude."; \
		else echo "  No Anthropic key (ANTHROPIC_API_KEY, or the Keychain's anthropic-api-key): agents' calls to Claude replay only."; fi

# The factory's GitHub App key, from the macOS Keychain (base64, because the Keychain prints a value with newlines as
# hex), goes to the cluster the same way: through stdin, decoded on the way. Without it the GitHub worker reads and
# writes nothing. Restart the worker after changing the key.
github-key:
	@if security find-generic-password -s factory-github-app-key >/dev/null 2>&1; then \
			security find-generic-password -s factory-github-app-key -w | base64 -d | \
				$(KUBECTL) -n factory create secret generic github-app --from-file=private-key=/dev/stdin --dry-run=client -o yaml | \
				$(KUBECTL) apply -f - >/dev/null && echo "  The GitHub worker has the App's key, so it acts as the factory in GitHub."; \
		else echo "  No App key (the Keychain's factory-github-app-key): the GitHub worker reads and writes nothing."; fi

# The scoreboard's Secrets (deploy/base/scoreboard). Its role's password, made once, is in two: `factory`'s, for the
# migrations that set it, and the scoreboard's own, for its pod. The answer key, each entry's id and fingerprint and
# nothing else, goes from the private checkout to the cluster through stdin, checked as the scoreboard checks it, never
# written to a file. Without the checkout there is no key, and any key written before is deleted: the scoreboard is off.
# It reads the key when it starts, so this restarts it. The migrations set the role's password from `factory`'s Secret
# when Argo CD next syncs, so on a cluster made before the scoreboard, run this before the deploy that brings it.
scoreboard-secrets: node_modules ## Give the scoreboard its password, and the answer key from the private checkout (PRIVATE_DIR)
	@$(KUBECTL) create namespace scoreboard --dry-run=client -o yaml | $(KUBECTL) apply -f - >/dev/null
	@$(KUBECTL) -n factory get secret postgres-scoreboard >/dev/null 2>&1 || \
		printf %s "$$(openssl rand -hex 24)" | \
		$(KUBECTL) -n factory create secret generic postgres-scoreboard --from-file=password=/dev/stdin >/dev/null
	@password="$$($(KUBECTL) -n factory get secret postgres-scoreboard -o jsonpath='{.data.password}' | base64 -d)" && \
		[ -n "$$password" ] && printf %s "$$password" | \
		$(KUBECTL) -n scoreboard create secret generic postgres --from-file=password=/dev/stdin --dry-run=client -o yaml | \
		$(KUBECTL) apply -f - >/dev/null
	@if [ -d "$(PRIVATE_DIR)/defects" ]; then \
			key="$$(node scripts/answer-key.ts "$(PRIVATE_DIR)")" && printf %s "$$key" | \
				$(KUBECTL) -n scoreboard create secret generic answer-key --from-file=key.json=/dev/stdin --dry-run=client -o yaml | \
				$(KUBECTL) apply -f - >/dev/null && echo "  The scoreboard has the answer key, so it counts the tickets."; \
		else $(KUBECTL) -n scoreboard delete secret answer-key --ignore-not-found >/dev/null && \
			echo "  No private checkout at $(PRIVATE_DIR): no answer key, and the scoreboard is off."; fi
	@$(KUBECTL) -n scoreboard delete pod -l app.kubernetes.io/name=scoreboard --ignore-not-found >/dev/null

# A password for each worker's own role in the store, in a Secret of its own, made once: the migrate Job sets each role's
# password from it as Argo CD syncs. Each goes through stdin, never on a command line. On a cluster made before the
# workers had roles, run this before the deploy whose image brings their migration, or their roles have no password
# until the sync after it.
worker-secrets: ## Give each worker that uses the store a password for its own role
	@for worker in $(STORE_WORKERS); do \
		$(KUBECTL) -n factory get secret postgres-$$worker >/dev/null 2>&1 || \
			printf %s "$$(openssl rand -hex 24)" | \
			$(KUBECTL) -n factory create secret generic postgres-$$worker --from-file=password=/dev/stdin >/dev/null || \
			exit 1; \
	done

egress: ## Prove the fences: only the gateway, the GitHub worker and Kyverno leave the cluster; the scoreboard reaches Postgres alone, and no service account of ours may read its Secrets (needs the workers running)
	scripts/egress.sh

admission-ready: ## Say whether every image the guarded namespaces run is signed, so admission control can enforce
	scripts/admission-ready.sh

check: ## Lint, type-check, test, build the browser code, check generated files are current, render the manifests
	pnpm exec biome ci
	pnpm exec tsc
	pnpm exec tsc -p apps/console/web
	pnpm exec tsc -p apps/console/e2e
	pnpm exec vitest run --project unit --project database
	node docs/design/system/build.ts --check
	node packages/samples/src/export.ts --check
	node apps/factory/src/alerts/rules.ts --check
	node apps/factory/src/release/analysis.ts --check
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

# The artifacts copier runs the Postgres image the cluster runs, read from its StatefulSet: the image's one pin.
define apply-artifacts-copier
sed "s|image: postgres$$|image: $$($(KUBECTL) -n factory get statefulset postgres -o jsonpath='{.spec.template.spec.containers[0].image}')|" \
	deploy/k3d/artifacts-copier.yaml | $(KUBECTL) apply -f - >/dev/null
endef

samples: node_modules ## Load the sample work items into the cluster's store, with their times moved so the last is now
	@# Screenshots first, into the artifacts volume, through a pod that mounts it for a moment (and not one still
	@# going from an earlier run).
	@$(KUBECTL) -n factory delete pod artifacts-copier --ignore-not-found --wait >/dev/null
	@$(apply-artifacts-copier)
	@$(KUBECTL) -n factory wait pod/artifacts-copier --for=condition=Ready --timeout=2m >/dev/null
	@# No macOS metadata files in the archive (COPYFILE_DISABLE); Linux ignores the setting.
	@COPYFILE_DISABLE=1 tar -C packages/samples/log/artifacts -cf - . | \
		$(KUBECTL) -n factory exec -i artifacts-copier -- tar -C /var/lib/factory/artifacts -xf -
	@$(KUBECTL) -n factory delete pod artifacts-copier --wait=false >/dev/null
	@# Then the events, as the factory's writer, through a port-forward to Postgres.
	@$(call as-writer,ARTIFACTS_DIR=packages/samples/log/artifacts node apps/factory/src/cli.ts events load packages/samples/log)
	@echo "  Console  https://console.localhost:8443"

real-store: node_modules ## Replace the cluster's store with an empty one for real events (FORCE=1 if it holds some)
	@# As the database's owner, through a port-forward: only the owner may drop the schema.
	@$(KUBECTL) -n factory port-forward svc/postgres 15432:5432 >/dev/null 2>&1 & forward=$$!; \
		trap 'kill $$forward' EXIT; sleep 2; \
		PGHOST=127.0.0.1 PGPORT=15432 PGDATABASE=factory PGUSER=factory \
		PGPASSWORD="$$($(KUBECTL) -n factory get secret postgres -o jsonpath='{.data.password}' | base64 -d)" \
		node packages/store/src/real-store.ts $(if $(FORCE),--force)
	@# The samples' screenshots go too, and the console starts again from an empty history.
	@$(KUBECTL) -n factory delete pod artifacts-copier --ignore-not-found --wait >/dev/null
	@$(apply-artifacts-copier)
	@$(KUBECTL) -n factory wait pod/artifacts-copier --for=condition=Ready --timeout=2m >/dev/null
	@$(KUBECTL) -n factory exec artifacts-copier -- find /var/lib/factory/artifacts -mindepth 1 -delete
	@$(KUBECTL) -n factory delete pod artifacts-copier --wait=false >/dev/null
	@$(KUBECTL) -n factory rollout restart deployment/console >/dev/null
	@echo "  Console  https://console.localhost:8443"

stop-the-line: node_modules ## Stop the line: agents stop, workers take nothing new, a canary in flight aborts (REASON="...")
	@# Both halves run whichever fails: a canary is aborted even if the store cannot be reached, and the other way round.
	@{ $(call as-writer,node apps/factory/src/cli.ts line stop $(if $(REASON),--reason "$(REASON)")); } || failed=1; \
		KUBECTL="$(KUBECTL)" scripts/abort-canaries.sh || failed=1; exit $${failed:-0}

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
		echo "  Console  https://console.localhost:8443  $$(curl -sf --cacert "$(LOCAL_CA)/ca.crt" https://console.localhost:8443/version || echo '(not up yet)')"; \
		echo "  Website  http://website.localhost:8080   $$(curl -sf http://website.localhost:8080/version || echo '(not up yet)')"; \
		echo "  Grafana  http://grafana.localhost:8080"; \
		echo "  Argo CD  http://argocd.localhost:8080    read-only; the admin password is in the argocd-initial-admin-secret Secret"; \
	fi
