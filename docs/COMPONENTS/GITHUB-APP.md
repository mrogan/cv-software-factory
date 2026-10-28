# Factory GitHub App

The factory's identity in GitHub. Part of the [factory plane](README.md#factory-plane).

- **v1:** `mrogan-software-factory`, owned by the organisation `the-roganator` and installed there on the two public repositories alone, never on `cv-software-factory-private`. Its work shows as `mrogan-software-factory[bot]`. The GitHub worker asks GitHub for the installation of each repository it acts on, so no installation id is configured.
- **No webhook:** the factory polls.

Only the [GitHub worker](GITHUB-WORKER.md) holds its key.

## Permissions

- **Allowed:** contents (branches), pull requests, checks, issues.
- **Denied:** workflows, administration, variables, bypassing rulesets.

`APPS` in `scripts/github-settings.ts` declares these, and the review App's and the drift check App's, and its test fails if any grants a write of variables or administration. `apps/factory/test/credentials.test.ts` fails if any pod in a profile's rendered manifests but the GitHub worker's holds a GitHub credential, or if the GitHub worker's is another App's.
