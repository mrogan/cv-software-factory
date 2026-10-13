# Workers and images

Where the gateway, the GitHub worker, triage, the intake, the log watcher, the line, the probes, the crawler and the traffic generator run. Part of the [factory plane](README.md#factory-plane).

- **v1:** one Deployment each in `factory` (`deploy/base/factory`), one replica.
- **Later:** Spaces or S3 for artifacts, a cloud secret store for the key.

Each worker but the GitHub worker, which touches no store, writes to the [event store](EVENT-STORE.md) as the factory's writer, and to the artifacts volume (which the console still mounts read-only).

## Images

Three images, built by `build.yml`, signed there by digest with cosign's keyless signing as that workflow on main, each with an SBOM of each platform from Syft attested beside it. Each is pinned by digest per profile in a pull request the App opens (ADR 0005; [supply chain](SUPPLY-CHAIN.md)).

| Image | What it is | Runs |
|---|---|---|
| `factory` | Distroless Node | The gateway, the GitHub worker, triage, the intake, the log watcher, the line and the traffic generator |
| `factory-browser` | From the pinned Playwright image, running as an unprivileged user | The probes, the crawler and the canary's journeys |
| `factory-runner` | Node, git, pnpm through corepack, the Agent SDK | The [runners'](AGENT-RUNNERS.md) Jobs; the line is given its pinned reference as `RUNNER_IMAGE` |

Chromium runs without its own sandbox, which the restricted Pod Security Standard refuses it, so the pod's other fences carry that.

## Secrets

- **The gateway's cassettes** are on a volume only it mounts, so recordings of real reports stay in the cluster.
- **The gateway's key.** `make up` creates its Secret from `TYPESAFE_API_KEY` or the Keychain, through stdin and no file. With none, the gateway replays only.
- **The GitHub worker's key.** `make up` creates its Secret from the Keychain's `factory-github-app-key` the same way. With none, that worker reads and writes nothing.
