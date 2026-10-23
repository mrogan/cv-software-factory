# Admission control

Refuses unsigned images. Part of the [runtime plane](README.md#runtime-plane).

- **v1:** Kyverno 1.19 (ADR 0010), installed by Argo CD from its chart at a pinned version, its images by digest, before anything it guards.

## The policy

One `ImageValidatingPolicy` (`deploy/base/admission/images`), in three copies, each admitting only the images its namespaces run:

| Copy | Namespaces | Admits |
|---|---|---|
| `factory-images` | `factory`, `runners` | The factory's images, Postgres and its exporter |
| `website-images` | `website` | The app's image, and the factory's browser for the canary's analysis |
| `scoreboard-images` | `scoreboard` | The factory's own image, which the [scoreboard](SCOREBOARD.md) runs |

A pod's images, its init and debug containers' and its image volumes' included, must be by digest, and either:

- **ours on GHCR,** from a repository its copy admits, signed keyless by `build.yml` on `main` of the repository that builds them (the identity compared whole; [supply chain](SUPPLY-CHAIN.md)); or
- **named by digest in the policy, with a reason** (Postgres and its exporter, in `factory`).

It checks the signature, not the SBOM: the deploy pull requests' checks verify that, where parsing it is cheap.

## Behaviour

- **A refusal** names the policy, the check and the images.
- **It fails closed.**
- **Outside it:** Kyverno's namespace, Argo CD's and the system's. Telemetry's, the pod log collector's and Argo Rollouts' are not guarded, since they run only upstream charts.
- **Every copy enforces.**
- **Its verdicts are cached in memory,** so after a restart it verifies everything again.

## Reaching out

Its admission controller alone may leave the cluster, for GHCR and Sigstore's TUF repository: the internet on 443 outside private addresses, the nearest a NetworkPolicy gets to naming them (#176; [network policies](NETWORK-POLICIES.md#kyverno)).

## Memory

It has a 1 Gi memory limit. cosign's bundle discovery fetches and parses every bundle attached to an image, attestations included, and `factory-browser`'s SBOM attestations are about 23 MB per platform.

## Trying unmerged images

- The `try-the-line` skill switches `factory-images` to audit for a run on images built on the Mac. Audit reports what it would refuse (`kubectl get policyreports -A`), and admits it.
- `website-images` and `scoreboard-images` are never switched.

## The admin service's hold on the Rollout

The [admin service](ADMIN-SERVICE.md#the-canarys-controls) may get and patch the app's Rollout and its status, by name, for Martin's controls of the canary. A Role names objects, not fields, so `website-rollout-controls` (`deploy/base/admission/website/rollout-controls.yaml`) holds each of its requests to the fields those controls set:

- `spec.paused`, to pause and resume;
- `status.abort`, set or cleared, to abort and retry;
- `status.currentStepIndex`, forward only and no further than past the last step, with `status.pauseConditions` and `status.controllerPause` cleared, never set, to promote to the next step's weight;
- `status.promoteFull`, set, to promote fully.

Everything else in the spec and the status, and the Rollout's labels, annotations, finalizers and owners, must be as they were, and nothing may be made or deleted, so nothing the admin service does can change the image, the steps, the analysis or the routing. Within those fields the service holds itself: the Rollout's status does not tell a rollback from an abort, so the policy admits `status.abort` cleared after either, and only the service refuses to retry a release the analysis rolled back. It is a ValidatingAdmissionPolicy, Kubernetes's own, rather than Kyverno's: the API server evaluates it in process, so it holds whether or not Kyverno is up. It matches the admin service's service account alone (`system:serviceaccount:factory:admin`), denies, and fails closed. Argo Rollouts' controller, Argo CD and the line are not held by it.

## Checks

- `make admission-ready` says whether every image the guarded namespaces run or will start would be admitted.
- Kyverno's refusals are kept in `deploy/test/admission-refusals.json` (`scripts/admission-refusals.sh`).
- `scripts/rollout-refusals.sh` asks the cluster, as the admin service's account, for the controls' patches and for the changes the policy and the Role must refuse, each a server-side dry run, and keeps the answers in `deploy/test/rollout-refusals.json`, which `release-fences.test.ts` reads.
- `release-fences.test.ts` fails if the Role or the policy grows.
