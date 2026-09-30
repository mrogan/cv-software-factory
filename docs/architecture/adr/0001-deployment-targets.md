# 0001: Local first, then replay site, always-on DigitalOcean and on-demand AWS

## Decision

Develop on a local k3d cluster. Publish a static replay site on GitHub Pages first, then run an always-on live instance on a single DigitalOcean Kubernetes node, and stand up AWS (EKS) with Terraform only on demand, for interviews. One CI pipeline and one set of manifests serve every target through Kustomize overlays.

## Why

The audiences differ: recruiters need a link that always works, engineers want to try it live, and interviewers value AWS. Running AWS permanently is too expensive, and a local-only project cannot be seen. Keeping one pipeline and one manifest set makes portability a feature rather than a maintenance burden. On-demand AWS also starts from the seeded baseline every time.

## Consequences

- A weekly job applies, smoke-tests and destroys the AWS profile so it does not rot.
- The live instance must enforce visitor spend caps, since it runs unattended.
