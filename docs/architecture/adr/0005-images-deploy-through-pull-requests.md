# 0005: Images reach a cluster through pull requests that pin their digests

## Decision

Every image a cluster runs is pinned by digest, per profile, in the repository that builds it: the factory's images in this repository's overlays, the app's in its own. When CI builds a new image, the factory's GitHub App opens a pull request in that repository that moves the pin, and merging that pull request is the deployment: Argo CD deploys what each repository's `main` says. There is one open deploy pull request per image, always for the latest build.

## Why

Git stays the whole truth about what is running, and a deployment is reviewable, signed and revertible like any other change. The alternatives each break that. A mutable tag makes the cluster's state depend on when it last pulled. Argo CD Image Updater puts git write access in the cluster. Letting CI push to `main` gives a workflow a way round the ruleset. And a workflow that opens pull requests needs a token that can, which is also one that could approve them.

## Consequences

- A release to a cluster takes one more merge than a build. That merge is where autonomy applies: Martin makes it while the factory is Supervised, and the gates decide later.
- A pin lives beside the build that made its image. The build workflow builds and pushes, tagged and labelled with its commit, and opens nothing. The factory's GitHub worker sees the new image in GHCR and, as the App, opens the pull request; it is the only thing that holds the App's key. No workflow may open or approve a pull request (`scripts/github-settings.ts`). Argo CD watches both repositories.
- The pin lives in a file of its own (a Kustomize component), so the deploy diff is one line.
- `main` accepts only signed commits, so the pin is committed through GitHub's API, which signs it.
- Each deploy pull request is labelled with its profile (`deploy: local`), so it is told apart from the release pull request and from Martin's own. `scripts/github-settings.ts` makes the label.
- The App's pull requests run their checks at once, without anyone approving the runs.
- Merging the deploy pull request must not build again, so the build watches only what goes into the image.
- A deploy pull request builds no image in its checks. Instead they confirm each digest it pins is in GHCR and labelled with a commit on `main`, so a digest from a branch's build, or a typo, cannot merge. They skip the browser tests, which nothing in a pin can change. Only a pull request the App opened, changing only the pin files, is treated so; anything else runs every check.
