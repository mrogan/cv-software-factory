# Security scanning

Code, dependencies, images and secrets. Part of the [GitHub plane](README.md#github-plane).

- **v1:** CodeQL, Dependabot, GitHub secret scanning, and two gates on the app's pull requests.
- **Later:** Semgrep, licence checks.

## On the app's pull requests

- **Dependency review** (GitHub's) fails a dependency with a known vulnerability the change brings in.
- **Trivy** (pinned by digest) scans the base's image and the change's, and fails on a high or critical vulnerability only the change's has.
