# 0005: Images reach a cluster through pull requests that pin their digests

## Decision

Every image a cluster runs is pinned by digest, per profile, in the repository that builds it: the factory's images in this repository's overlays, the app's in its own. When CI builds a new image, it opens a pull request in its own repository that moves the pin, and merging that pull request is the deployment: Argo CD deploys what each repository's `main` says. There is one open deploy pull request per image, always for the latest build.

## Why

Git stays the whole truth about what is running, and a deployment is reviewable, signed and revertible like any other change. The alternatives each break that. A mutable tag makes the cluster's state depend on when it last pulled. Argo CD Image Updater puts git write access in the cluster. Letting CI push to `main` gives a workflow a way round the ruleset.

## Consequences

- A release to a cluster takes one more merge than a build. That merge is where autonomy applies: Martin makes it while the factory is Supervised, and the gates decide later.
- A pin lives beside the build that moves it, so a workflow's own token is enough to propose a deployment and no credential crosses repositories. Argo CD watches both repositories.
- The pin lives in a file of its own (a Kustomize component), so the deploy diff is one line.
- `main` accepts only signed commits, so the pin is committed through GitHub's API, which signs it.
- Until the factory has its GitHub App (milestone 5), the pull request is opened by a workflow, and GitHub holds its checks until Martin approves the runs. Checks dispatched on the branch do not count towards the ruleset.
- Merging the deploy pull request must not build again, so the build watches only what goes into the image.
