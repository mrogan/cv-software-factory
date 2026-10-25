# 0013: Everything the factory builds or runs is scanned every day, and each finding is fixed by a deadline

## Decision

A known vulnerability is looked for in everything the factory and the app build or run, not only in what a pull request changes. It is looked for every day, against that day's advisories, and each finding has a deadline by its severity.

### What is scanned

The list of what is scanned is worked out from each repository, never kept by hand:

- **Each repository's lockfile,** development dependencies included, since they run in CI beside its tokens and on Martin's Mac.
- **Each image of ours that `main` pins,** from the SBOMs `build.yml` attests, so nothing large is pulled.
- **Each third-party image the manifests pin by digest:** Postgres, its exporter, the proxy's nginx, and flagd once it is deployed.
- **The platform:**
  - each image the platform's charts run at the versions `deploy/` pins, rendered with our values: Argo CD, Argo Rollouts, Kyverno, Prometheus and Alertmanager, Grafana, Loki, Tempo and the collector;
  - the k3s node image `deploy/k3d/cluster.yaml` pins, and the images that k3s release starts (Traefik and CoreDNS among them).
- **The Node binary** in each image, not only its packages.

A test renders the manifests and fails when an image they run is not on the list. An item the scan cannot read is a finding in itself, so nothing is left out quietly. The workflows' actions stay with Dependabot, which already sees them.

### How it is scanned

- **One scanner, Trivy, pinned by digest,** as the app's image gate already pins it, so the gates, the daily scan and Part D's routing check agree on what a finding is and how severe it is.
- **It reads the lockfiles itself.** GitHub's dependency graph does not read these pnpm lockfiles: it lists each `package.json`'s ranges and none of the packages they resolve to, so Dependabot's alerts and dependency review see direct dependencies alone. A test compares the packages the scanner reads with the ones `pnpm list` gives, and fails when they differ.
- **A scan fails closed.** One that cannot read a lockfile or an SBOM, reach an image, or fetch the day's advisories fails, and is never read as clean.

### When it is scanned

- **On every pull request, in both repositories:** the base's lockfile against the change's, failing on any known vulnerability the change brings in, as dependency review does today. It runs as the app's gates do: on `pull_request`, with a read-only token, executing nothing from the change. The app's image gate stays as it is.
- **Every day, and on each push to `main`:** everything on the list, against that day's advisories. The results go to code scanning in the repository that owns each item, one alert for each package and advisory, located in its lockfile or naming its image. The app calls the workflow from this repository at a pinned commit, as it calls Scorecard, so it scans its own lockfile and images.

### The dependency graph

On each push to `main`, a job submits Syft's SBOM of the lockfile to GitHub's dependency submission API, so Dependabot's alerts and its security updates see every package. That job alone holds `contents: write`, runs only on a push to `main`, and executes nothing from the repository. The pull request gate does not depend on it.

### Deadlines

A finding's severity is the higher of the scanner's rating and that of the project that published the fix, as milestone 7's Patching decisions set. Its deadline counts from the day its fix can be installed (published, and past pnpm's day or the image's release):

| Severity | Fixed within |
|---|---|
| Critical | 2 days |
| High | 7 days |
| Medium | 30 days |
| Low | 90 days |

A finding with no fix has no deadline. It stays open, and is looked at again when a fix appears. The daily scan reports each open finding's age against its deadline.

### Exceptions

A finding that cannot reach us (a package installed but never loaded, a path never called) is excepted in `policy/vulnerabilities.ts`. Each entry gives the repository, the advisory, the package, why it cannot reach us, and an expiry no more than 90 days away. When an entry expires, its finding returns.

The file is code-owned, and the scan reads it from this repository at the commit it runs from. It never reads an ignore file from the repository it scans, since agents write to the app's repository. Scorecard reads `osv-scanner.toml` beside each lockfile, so each is generated from the policy, code-owned in its repository, and a check fails when one differs from it.

### Who fixes it

- **The app:** the line, as milestone 7's Patching (Part D) sets out.
- **The factory's lockfile, its images and the platform:** Martin. Dependabot's security updates, once it sees every package, propose most of them.

The daily scan fails on a new High or Critical finding, and on any deadline passed. A failed scheduled run is GitHub's own notice to Martin, with no new secret in CI. From Part D, the factory reads each day's results with its App and alerts him at Notify, through Alertmanager.

## Why

- **Most vulnerabilities arrive in code nobody changed.** A gate on pull requests sees only what a change brings in. An advisory published tomorrow against a package locked today is found only by scanning again. Each image's SBOM is already attested, so scanning again every day costs a download of the day's advisories.
- **CI, not the cluster.** The local cluster is not always running, and its egress is fenced to what each part needs. A scanner inside it would need the advisory database's hosts, and would see nothing while the cluster is down. A finding is about what `main` pins. Part D's sense compares the running digests with what was scanned, so drift is caught there.
- **Trivy, not a second scanner.** The app's image gate already pins it, and Part D's routing check decides on its rating alone. Two scanners would disagree about severity and coverage, and a Critical fix could merge on one and fail on the other.
- **Not GitHub's dependency graph alone.** It reads manifests here, not the lockfiles, and dependency review's comparison is only as complete as the graph. Submitting the graph brings back Dependabot's security updates, the quickest route to a fix for the factory. The gate stays on our own scanner, so it never waits on a snapshot or a token that can write.
- **Scorecard is an outside score, not the detector.** It runs weekly and on each push, and reports all its findings as one alert with no file, which notifies no one. It stays, as spec 8 asks: generating its ignore file from the same policy keeps its score honest about what is excepted.
- **Deadlines make time to patch something that can be measured.** Without them, a finding has no owner and no date. The figures follow common practice for internet-facing software, scaled to one maintainer: Critical within two days of a fix being installable, since pnpm's day takes one of them.
- **Exceptions live where agents cannot write.** An ignore file in the app's repository would let a change there hide a vulnerability from the gate that judges it.

## Consequences

- Scanning everything finds what is already there. The first full scan opens alerts on the platform's images and on development dependencies, each with its deadline from that day.
- Each repository's code scanning shows one alert for each package and advisory, so a finding has a file or an image, and can be dismissed, with a reason, by an exception.
- A day when Trivy's advisory database cannot be fetched is a failed run, not a clean one.
- The factory's App needs to read code scanning alerts in both repositories from Part D, a change to its permissions in `github-settings.ts`.
- Charts pin images by tag, not digest, so a platform image is scanned as the tag resolves that day. Pinning the platform's images by digest is not part of this decision.
- Scorecard's Vulnerabilities score rises only as findings are fixed or excepted.
