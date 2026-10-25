# Feature flags

Ship improvements switched off; a kill switch without a rollback. Part of the [runtime plane](README.md#runtime-plane).

- **v1:** OpenFeature with flagd.

## Where it runs

- **flagd 0.17, alone in `flagd`,** not in the app's pod or beside it in `website` (`deploy/base/flagd`). The app's pods hold no token and no route to the Kubernetes API, and nothing the app's repository may write in `website` can touch flagd, its service account or its state.
- **The state of every flag is one `FeatureFlag`, `flags` in `flagd`,** which flagd watches through the Kubernetes API. Only the kind's definition is installed, vendored from OpenFeature's operator at the API version flagd builds against, not the operator itself. In Git it has no flags. Argo CD makes it before flagd starts, and leaves its flags alone ([GitOps](GITOPS.md#syncing)).
- **flagd reads, and writes nothing.** Its watch lists the whole namespace, so its Role may get, list and watch `featureflags` in `flagd`, with no names. Admission keeps `flags` the only one there and refuses its deletion, since flagd keeps serving the last flags it read when its resource goes ([admission control](ADMISSION-CONTROL.md#flags)). Nothing of ours may write `flags` yet.
- **The app's pods reach flagd's sync port (8015) and its health port (8014), and nothing else of it** ([network policies](NETWORK-POLICIES.md#flagd)). flagd reaches the Kubernetes API, DNS and the collector, where its traces and metrics go; its logs are its container's.
- **Its image is admitted by digest** in a copy of admission control of its own, `flagd-images`, so `website-images` still admits no third-party image.

## Readiness

flagd reads `flags` before it serves anything, and exits if it cannot: with the resource missing, its Role or binding missing, or the API out of reach, it restarts until it can, and is never ready. A first flag set it refuses leaves it unready. Once ready it stays ready: at 0.17 its readiness does not follow its watch, which retries a broken watch for ever while flagd serves the last flags it took.
