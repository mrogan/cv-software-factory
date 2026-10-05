# 0008: Runners hand back a patch, and nothing outside the sandbox runs git in it

## Decision

An agent works in a runner: two Kubernetes Jobs in the `runners` namespace, sharing a volume that lives as long as the work item. The prepare pod may reach GitHub and the npm registry; it checks out the base commit and installs its dependencies onto the volume. The agent pod reaches the gateway and the line's handback and nothing else, holds no credential (only a job token the gateway and the handback accept for that work item and agent, until the job ends), and runs the agent there on the Agent SDK.

At the end of its step the agent pod hands back a patch: a unified diff of what the agent changed, and a short note. The patch is data. The line checks its size and every path in it against the spec's scope. The GitHub worker reads the files it changes from GitHub at the branch's head, applies the patch in memory, and commits the result through GitHub's API, which signs it as the App.

## Why

- **A NetworkPolicy fences a pod, not a container.** Checking out and installing need the internet; the agent must not have it. Two pods let each have exactly the network it needs, and the volume carries the work between them.
- **The sandbox's working tree is hostile ground.** The agent ran there with every permission inside the fence, and anything in the app's repository can tell it what to do. A git hook or config planted in that tree would run with the rights of whatever ran git in it next. So nothing outside the sandbox does: the patch crosses the boundary as text, and is applied by code that reads it, not by git.
- **A patch is easy to judge.** Its paths are explicit, so the scope fence is a few lines of deterministic code, and a patch outside its scope never reaches GitHub.
- **The App signs.** A commit made through `createCommitOnBranch` is signed by GitHub as the App, which `main`'s ruleset requires, with no signing key anywhere in the factory.

## Consequences

- Patches are plain text changes: a binary file, a rename (written as a deletion and an addition instead) or a change of mode is refused.
- The agent pod checks its own fence before it starts the agent: a pod is fenced a moment after it starts, and nothing untrusted runs until the internet is out of reach.
- A second round's patch, after review, holds only that round's changes: the runner commits each handback in its own checkout, and the GitHub worker applies the next patch on the branch's head.
- A dry run of the GitHub worker remembers the commits it would have made, so a second patch, or the smoke run's patch on its seeded base, applies on top of them.
