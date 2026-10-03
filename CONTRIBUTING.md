# Contributing

Thank you for looking. This repository is unusual: most of its work is meant to be done by the factory itself. Agents write the code, deterministic gates decide what ships, and I (Martin Rogan) own the rules and review what matters. It is also my portfolio, so I keep its scope deliberately narrow.

## Issues

Bug reports, questions and ideas are welcome. Use the issue templates.

The factory acts only on issues it opened itself or that I have labelled for it, so opening an issue never sets an agent to work on its own. Until the factory is running, I read and triage every issue myself.

## Pull requests

Small fixes (typos, broken links, clearer docs) are welcome as pull requests. For anything larger, please open an issue first, because I may decline a good change that doesn't fit the project.

Because the repository is public, outside pull requests are treated as untrusted:

- Workflows from a first-time contributor wait for my approval before they run.
- Pull requests run with read-only permissions and no secrets (`pull_request`, never `pull_request_target`).
- Nothing from outside is merged automatically.

## Working on it

The toolchain is pinned in `mise.toml`, so one command installs it:

```sh
mise install
pnpm install
make check    # lint, type-check, tests, design tokens, manifests
pnpm dev      # the console on http://localhost:5173, with the samples
make e2e      # the console in a browser: accessibility, security headers, speed, visual snapshots
```

A snapshot that fails only on CI usually comes down to timing, and CI's runner is slower than a laptop. It often reproduces in the pinned image given less CPU: run the `docker run` line from `make e2e` with `--cpus=1.5`, and pass `-g "<test name>" --repeat-each=15` to `in-docker.sh`.

Or open the repository in its dev container.

- Commits and pull request titles follow [Conventional Commits](https://www.conventionalcommits.org): `fix(console): …`, `docs: …`. A commit hook checks them.
- Pull requests are squash-merged; `main` accepts nothing else.
- Keep the docs current in the same pull request as the change. Start with [`AGENTS.md`](AGENTS.md): it applies to people as well as agents.

By contributing, you agree that your contribution is licensed under the [MIT licence](LICENSE).
