# GitOps

Cluster state reconciled from git. Part of the [runtime plane](README.md#runtime-plane).

- **v1:** Argo CD app of apps, with one Kustomize overlay per profile.

## Argo CD itself

Argo CD deploys everything but itself. `make up` installs it with Helm from [`deploy/argocd/values.yaml`](../../deploy/argocd/values.yaml), so a change there reaches the cluster at the next `make up`, which upgrades the release in place, and not when it merges. The values give each of its components a memory limit from what it uses, so a bad sync cannot take the memory of what shares its node.

## Image pins

Each overlay pins image digests. The factory's [GitHub worker](GITHUB-WORKER.md#deploys) opens a pull request to move them when CI builds new images, labelled with the profile (`deploy: local`).

## The app's project

The app deploys from its own repository through its own Argo CD project, which allows these in the `website` namespace, and nothing else:

- Rollouts;
- Services;
- ConfigMaps;
- `TraefikService`s;
- `IngressRoute`s;
- `Middleware`s.

## Syncing

- **Weights.** Argo CD leaves the traffic split's weights to Argo Rollouts ([progressive delivery](PROGRESSIVE-DELIVERY.md)).
- **Replacements.** Argo CD removes what a change replaces only once its replacement is healthy.
- **Waves.** Root rolls each child Application's health into its own, so a later sync wave waits for an earlier one.
- **The website is in the last wave,** so a canary (Suspended) or a rollback (Degraded) holds back no change to the factory.
- **`make up`** waits for everything else to be healthy, and for the website only to settle (`scripts/wait-deployed.sh`).
