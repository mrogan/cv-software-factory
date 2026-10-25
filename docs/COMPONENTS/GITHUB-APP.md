# Factory GitHub App

The factory's identity in GitHub. Part of the [factory plane](README.md#factory-plane).

- **v1:** `mrogan-software-factory`, owned by the organisation `the-roganator` and installed there on the two public repositories alone, never on `cv-software-factory-private`. Its work shows as `mrogan-software-factory[bot]`. The GitHub worker asks GitHub for the installation of each repository it acts on, so no installation id is configured.
- **No webhook:** the factory polls.

Only the [GitHub worker](GITHUB-WORKER.md) holds its key.

## Permissions

- **Allowed:** contents (branches), pull requests, checks, issues.
- **Denied:** workflows, administration, bypassing rulesets.
