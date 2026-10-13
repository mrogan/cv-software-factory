# Factory GitHub App

The factory's identity in GitHub. Part of the [factory plane](README.md#factory-plane).

- **v1:** `mrogan-software-factory`, on Martin's account and installed on the two public repositories. Its work shows as `mrogan-software-factory[bot]`.
- **No webhook:** the factory polls.

Only the [GitHub worker](GITHUB-WORKER.md) holds its key.

## Permissions

- **Allowed:** contents (branches), pull requests, checks, issues.
- **Denied:** workflows, administration, bypassing rulesets.
