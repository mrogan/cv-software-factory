# Admission control

Refuses unsigned images. Part of the [runtime plane](README.md#runtime-plane).

- **v1:** Kyverno 1.19 (ADR 0010), installed by Argo CD from its chart at a pinned version, its images by digest, before anything it guards.

## The policy

One `ImageValidatingPolicy` (`deploy/base/admission/images`), in four copies, each admitting only the images its namespaces run:

| Copy | Namespaces | Admits |
|---|---|---|
| `factory-images` | `factory`, `runners` | The factory's images, Postgres and its exporter |
| `website-images` | `website` | The app's image, and the factory's browser for the canary's analysis |
| `scoreboard-images` | `scoreboard` | The factory's own image, which the [scoreboard](SCOREBOARD.md) runs |
| `flagd-images` | `flagd` | [flagd](FEATURE-FLAGS.md)'s image, by digest, and none of ours |

A pod's images, its init and debug containers' and its image volumes' included, must be by digest, and either:

- **ours on GHCR,** from a repository its copy admits, signed keyless by `build.yml` on `main` of the repository that builds them (the identity compared whole; [supply chain](SUPPLY-CHAIN.md)); or
- **named by digest in the policy, with a reason** (Postgres and its exporter, in `factory`; flagd, in `flagd`).

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
- `website-images`, `scoreboard-images` and `flagd-images` are never switched.

## The admin service's hold on the Rollout

The [admin service](ADMIN-SERVICE.md#the-canarys-controls) may get and patch the app's Rollout and its status, by name, for Martin's controls of the canary. A Role names objects, not fields, so `website-rollout-controls` (`deploy/base/admission/website/rollout-controls.yaml`) holds each of its requests to the fields those controls set:

- `spec.paused`, to pause and resume;
- `status.abort`, set or cleared, to abort and retry;
- `status.currentStepIndex`, forward only and no further than past the last step, with `status.pauseConditions` and `status.controllerPause` cleared, never set, to promote to the next step's weight;
- `status.promoteFull`, set, to promote fully.

Everything else in the spec and the status, and the Rollout's labels, annotations, finalizers and owners, must be as they were, and nothing may be made or deleted, so nothing the admin service does can change the image, the steps, the analysis or the routing. Within those fields the service holds itself: the Rollout's status does not tell a rollback from an abort, so the policy admits `status.abort` cleared after either, and only the service refuses to retry a release the analysis rolled back. It is a ValidatingAdmissionPolicy, Kubernetes's own, rather than Kyverno's: the API server evaluates it in process, so it holds whether or not Kyverno is up. It matches the admin service's service account alone (`system:serviceaccount:factory:admin`), denies, and fails closed. Argo Rollouts' controller, Argo CD and the line are not held by it.

## `flags`

`flags` in `flagd` holds the state of every [feature flag](FEATURE-FLAGS.md). flagd's watch lists the whole namespace, so its Role may read every FeatureFlag there, and flagd keeps serving the last flags it read when its resource goes. So `flagd-flags` (`deploy/base/admission/flagd/flags.yaml`) refuses any FeatureFlag in `flagd` but `flags`, and refuses the deletion of `flags`, but as its namespace is deleted, which takes flagd with it: off is a change to a flag, never a deletion. It holds every request, Argo CD's and an administrator's included. Like the hold on the Rollout, it is a ValidatingAdmissionPolicy, which holds whether or not Kyverno is up; it denies, and fails closed.

## The mark

The factory's own checks send `x-unmeasured` (`UNMEASURED`, `senses/http.ts`), and a [feature flag](FEATURE-FLAGS.md)'s first stage is on for the requests that carry it. The network keeps visitors from sending it: the app's route through Traefik passes every request through the app's Middleware `visitors`, which removes it, and only the pods its [network policy](NETWORK-POLICIES.md#website) names reach the app any other way. That route and that Middleware are in the app's repository, which agents write, so `website-mark` (`deploy/base/admission/website/mark.yaml`) holds what that repository may make in `website`:

- **An `IngressRoute`:** each route's middlewares are `visitors` alone, in `website`, since a second one after it could set the header again. Its services carry no middlewares of their own, and name nothing in another namespace or provider (`name@provider`: `api@internal` would serve Traefik's own API on the app's host).
- **A `TraefikService`:** a weighted split alone, as the canary's is, held to the same rule for each service it shares out.
- **A `Middleware`:** the strip and nothing else, `headers` with `customRequestHeaders` removing `x-unmeasured` (an empty value removes a header). It is an allow-list, not a list of what is refused, because at Traefik 3.7 several kinds could put the header back: `headers` sets any request header, in any casing of its name; `forwardAuth` copies headers from an auth server's answer (`authResponseHeaders`, `authResponseHeadersRegex`); `basicAuth` and `digestAuth` write the user to a header they name (`headerField`); `chain` runs others; and `plugin` runs anything.

Traefik itself refuses a reference to an object in another namespace, so a route in `website` cannot name another namespace's Middleware or Service, and a route elsewhere cannot name the app's. An address is no such reference (a `forwardAuth` elsewhere could name the app's Service by URL), but only this repository makes Middlewares outside `website`. k3s's bundled chart leaves `providers.kubernetescrd.allowCrossNamespace` and `allowExternalNameServices` off, and nothing here changes its values: no `HelmChartConfig`, and no k3s argument in `deploy/k3d/cluster.yaml`. The app's project admits no other kind Traefik routes by: no `Ingress`, no `IngressRouteTCP`, no Gateway API route. The policy holds every request, Argo CD's and Argo Rollouts' among them, and fails closed. It is Kyverno's, as `website-routes` is, so it compares a Middleware's whole spec with the strip.

## Checks

- `make admission-ready` says whether every image the guarded namespaces run or will start would be admitted.
- Kyverno's refusals are kept in `deploy/test/admission-refusals.json` (`scripts/admission-refusals.sh`).
- `scripts/rollout-refusals.sh` asks the cluster, as the admin service's account, for the controls' patches and for the changes the policy and the Role must refuse, each a server-side dry run, and keeps the answers in `deploy/test/rollout-refusals.json`, which `release-fences.test.ts` reads.
- `release-fences.test.ts` fails if the Role or the policy grows.
- `scripts/flags-refusals.sh` asks the cluster for a second FeatureFlag in `flagd`, the deletion of `flags` and a change to its flags, each a server-side dry run, and keeps the answers in `deploy/test/flags-refusals.json`, which `flag-fences.test.ts` reads.
- `scripts/mark-refusals.sh` asks the cluster, in `website`, for the app's route, split and Middleware as its repository has them and for each way to put the mark back, and sends back unchanged each of those kinds already in `website`, each a server-side dry run, and keeps the answers in `deploy/test/mark-refusals.json`, with Traefik's arguments and environment and the k3s they ran on, which `mark-fences.test.ts` reads.
