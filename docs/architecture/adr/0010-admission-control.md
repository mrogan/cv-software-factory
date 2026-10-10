# 0010: Admission control admits only images their pipeline signed

## Decision

Kyverno, installed by Argo CD before anything it guards, admits a pod in `factory`, `runners` or `website` only if each of its images, its init and debug containers' and its image volumes' included, is referenced by digest and is either

- ours, on GHCR, from a repository its namespace runs, signed by `build.yml` on `main` of the repository that builds it; or
- one of the few third-party images its namespace's policy names by exact digest, each with its reason. Today that is Postgres, in `factory`, and nothing in `website`.

The signer is compared whole: the issuer is GitHub Actions' OIDC issuer, and the identity is `https://github.com/<repository>/.github/workflows/build.yml@refs/heads/main`, never a pattern. The factory's images must carry the factory's signature, the app's the app's.

The rule is one `ImageValidatingPolicy` (`deploy/base/admission/images`), in two copies, each admitting only the images its namespaces run:

- `factory-images`, for `factory` and `runners`: the factory's four images (`factory`, `factory-browser`, `factory-runner` and `console`), signed by the factory's `build.yml`, and Postgres by digest. None of the app's.
- `website-images`, for `website`: the app's image, signed by the app's `build.yml`, and of the factory's only `factory-browser`, for the analysis Job that walks a canary's journeys. No other registry.

An image of ours that its namespace does not run is refused before its signature is looked at, with a check of its own.

Enforcing, Kyverno fails closed: a pod it cannot verify, because GHCR or Sigstore is out of reach or Kyverno is down, is refused. A pod is checked when it is made and when a change to it changes its images, not when only its labels or finalizers change, so an outage never holds up a pod that is already running. Its own namespace, Argo CD's and the cluster's system namespaces are outside its webhooks, so the cluster can always start again. Telemetry's and Argo Rollouts' namespaces are not guarded: they run only upstream charts, whose images no pipeline of ours signs.

## Why

Signing (milestone 6, task 1) says which workflow made an image; admission is what makes that matter. Without it, anything that can write a manifest, a person, an agent's pull request, or a stolen token, can run any image it likes in the cluster, and the signature is only a label.

- **Kyverno**, rather than Sigstore's policy-controller or Connaisseur: one controller that verifies cosign's keyless signatures, writes its verdicts to reports in Audit mode, and is configured in plain resources Argo CD deploys. Its `ImageValidatingPolicy` reads the Sigstore bundles cosign 3 makes, kept as OCI referrers (on GHCR, under the `sha256-<digest>` tag), which is how task 1 signs.
- **The signature, not the SBOM.** Admission verifies the signature. The SBOM attestation is verified where it is cheap, by the deploy pull request's checks (`cosign verify-attestation --type spdxjson`), so every pinned image has one. Checking it again at admission would mean parsing tens of megabytes per image as pods start (`factory-browser`'s is about 23 MB per platform), inside a webhook that fails closed. Admission on SLSA provenance is not part of this milestone.
- **Two copies, not one policy:** `website`, once it enforces, stays enforced always, because agents write to the app's repository and this is the fence a change there cannot move. The factory's side is switched to Audit for a run on images built on the Mac (the `try-the-line` skill), which a single policy could not do without opening `website` too.
- **Each copy names the repositories of ours it admits,** rather than admitting anything either pipeline signed. A signature says who built an image, not where it belongs: the factory's workers and runner, signed, have no business in `website`, nor the app in the factory's namespaces. A copy that admits only what its namespaces run makes a pinned image in the wrong place a refusal, not a surprise. A new image, or a new use of one, is a change to the policy.
- **An allowlist by digest** for third-party images, rather than refusing every other registry outright: Postgres is Docker's own build, which no pipeline of ours can sign, and rebuilding it to sign it would make us its maintainer. Naming its digest admits that exact image and nothing else from that registry; moving it is a change to the policy, reviewed like any other.
- **Pods, not the controllers that make them.** Kyverno can also check Deployments and Jobs, so a refusal shows in Argo CD rather than in a ReplicaSet's events, but only for a policy that matches pods alone; a debug container's image is a way in too, so the policy matches pods and their ephemeral containers.

## Consequences

- Nothing we run was signed before task 1 merged, so admission arrives in Audit: each copy reports what it would refuse (`kubectl get policyreports -A`) and admits it, though a Kyverno that is down still refuses. `make admission-ready` checks every image the guarded namespaces run or will start, as the policy does, and lists what Kyverno has reported; once it passes for a copy's namespaces, every image they need signed or named by digest, a pull request of its own removes that copy's Audit patch, and it enforces (#173). Until `website-images` does, the app's repository could pin any image.
- An outage of GHCR stops new pods in the guarded namespaces until it passes, Postgres's excepted. Kyverno keeps its verdicts for an hour, but it still reads each image's manifest from GHCR as it admits a pod, so even a restart on an image it has verified waits. Kyverno refreshes Sigstore's trust root from its TUF repository whenever it verifies, so an outage there stops a pod whose images it has not verified in the last hour.
- Kyverno's admission controller may reach GHCR and Sigstore's TUF repository; nothing else in its namespace may leave the cluster. A NetworkPolicy cannot name a host, and those hosts' addresses are many and change, so the rule is the nearest it gets, as for the GitHub worker: the internet on 443, outside the cluster's, the local network's and the host's addresses. `make egress` shows the admission controller reaching both, and the reports controller reaching neither. Egress by host name waits for milestone 10 (#176). The signatures carry their own proof of inclusion in Rekor, so Kyverno never asks Rekor or Fulcio.
- An image built on the Mac runs on the local cluster only while the factory's policy is in Audit, which `try-the-line` sets and Argo CD's self-heal undoes. Once `website-images` enforces, nothing built on the Mac can run in `website`.
- A new guarded namespace (the scoreboard's, in Part C) joins a copy's namespace list, and a test fails until every namespace the factory or the app runs in is guarded.
- Kyverno's refusals are kept, as the cluster gave them, in `deploy/test/admission-refusals.json` (`scripts/admission-refusals.sh`), for milestone 9's red team.
- No `PolicyException` can excuse a pod: the feature is off.
