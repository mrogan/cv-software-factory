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
- **Outside it:** Kyverno's namespace, Argo CD's and the system's. Telemetry's and Argo Rollouts' are not guarded, since they run only upstream charts.
- **Every copy enforces.**
- **Its verdicts are cached in memory,** so after a restart it verifies everything again.

## Reaching out

Its admission controller alone may leave the cluster, for GHCR and Sigstore's TUF repository: the internet on 443 outside private addresses, the nearest a NetworkPolicy gets to naming them (#176; [network policies](NETWORK-POLICIES.md#kyverno)).

## Memory

It has a 1 Gi memory limit. cosign's bundle discovery fetches and parses every bundle attached to an image, attestations included, and `factory-browser`'s SBOM attestations are about 23 MB per platform.

## Trying unmerged images

- The `try-the-line` skill switches `factory-images` to audit for a run on images built on the Mac. Audit reports what it would refuse (`kubectl get policyreports -A`), and admits it.
- `website-images` and `scoreboard-images` are never switched.

## Checks

- `make admission-ready` says whether every image the guarded namespaces run or will start would be admitted.
- Kyverno's refusals are kept in `deploy/test/admission-refusals.json` (`scripts/admission-refusals.sh`).
