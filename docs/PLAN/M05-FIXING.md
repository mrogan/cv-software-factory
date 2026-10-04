# Milestone 5: Fixing

Not yet planned. The outcome is the plan's line for milestone 5: a GitHub App, agent runners, the planner, coder and reviewer, code-owner review required on `main`, the App opening the deploy and release pull requests, CI gates in `cv-worlds-worst-website`, and one seeded defect fixed and merged with no human code, at Supervised autonomy.

## Input for planning

Notes for the agent that writes this plan: what is decided, what is measured, and options to weigh. Take them into the plan's decisions and tasks, settle the options with Martin, then delete this section.

### Carried in

- The backlog items marked for milestone 5, or before it: Dependabot's failing npm updates in the app's repository, the factory keeping its own pull requests up to date, Scorecard's Branch-Protection rising with code-owner review, the story of a finished work item, and a redirect loop filed under the linking page.
- `policy/spend.ts` gives each work item $2, a guess made before any agent ran. Measure what a fix costs and propose a figure.

### Decided

- **Claude does the agent work; a local model runs the unattended passes** (a soak of the whole line overnight, a regression pass after a change to the runner) that test the plumbing, not the agents. Jev stays for triage.
- **The coder hands back a patch.** A trusted component outside the sandbox commits it, pushes the branch and opens the pull request as the App, so the sandbox holds no credentials.
- **A factory worker opens the deploy and release pull requests.** It sees a new image, or a release due, and opens the pull request as the App. The App's private key stays in the cluster, and no workflow holds it or any token that can open a pull request.
- **Martin's own pull requests pass code-owner review by a bypass for the repository admin, for pull requests only.** Nobody can approve their own pull request on GitHub, and every human pull request is Martin's; a second account or the App approving for him would be theatre, and dropping the rule would leave the factory's pull requests unguarded. His changes still go through a pull request and its checks, and the merge records the bypass. Check how Scorecard's Branch-Protection scores it.
- **The coder does not apply coding standards or design rules.** They would compete with the work for its context. The reviewer applies them, and its findings go back to the coder, which knows the implementation best.
- **Rules live where the reader who needs them will look:**

  | Kind | Example | Home | Who reads it |
  |---|---|---|---|
  | Invariant: breaking it makes the change wrong or unsafe | interpolate only through `html`; copy in Gerald's voice; a change comes with its test | the repository's `AGENTS.md`, kept short | the coder, always |
  | Mechanical: a tool can check it | formatting, types, lint rules | Biome, `tsc` and the tests, as gates | the coder, only when a check fails |
  | Judgement: taste and design | deep modules, test at the seams, collaborators passed in | `docs/REVIEWERS.md`, not linked from `AGENTS.md` | the reviewer |

  Both repositories have a `docs/REVIEWERS.md` of five short rulings, owned by Martin in CODEOWNERS. The model knows the principles; the file names the ones chosen, each pointing to code that shows it, to keep reviews consistent and stop drift. The factory owns how to review (the reviewer's prompt and output schema); each repository owns what to review against.
- **Pull request descriptions fit the change.** One that needs a line gets a line; one that needs a diagram or a screenshot gets that. Short and plain throughout. The spec's line "Agent PRs follow a template: problem, evidence, change, tests, risk, rollout" and the pull request templates in both repositories become guidance, not headings to fill.

### Model access

Measured on Martin's MacBook Pro (M5 Pro, 48 GB) with LM Studio 0.4.25:

- **LM Studio speaks Anthropic's Messages API** at `http://localhost:1234/v1/messages`, with tools, streaming and thinking. Its OpenAI-compatible API returns schema-constrained JSON only with `reasoning_effort: none`, and gives no token probabilities.
- **Claude Code runs on a local model.** `claude -p`, pointed at LM Studio with `ANTHROPIC_BASE_URL`, fixed a seeded off-by-one in a scratch repository on `qwen/qwen3.8-27b`: 11 turns, 4 minutes, 124,000 input tokens of which 86,000 came from LM Studio's prefix cache. `google/gemma-4-12b` thought for over 5,000 tokens in one turn without editing anything.
- **Qwen 27B reads a prompt at about 390 tokens a second and writes at 17.** A real fix of around 50 turns would take 20 to 40 minutes: too slow for the runs development needs.
- **The cluster reaches the Mac's LM Studio** at `host.docker.internal` (OrbStack's `0.250.250.254`), with LM Studio listening only on `127.0.0.1`; `host.k3d.internal` does not reach it. The gateway's NetworkPolicy allows only port 443 outside the cluster. A model inside k3d gains nothing: OrbStack's Linux VM has no GPU.
- **The Agent SDK must use an API key**, billed per token from the Claude Console. Anthropic's terms allow no product built on the SDK to use or intermediate a subscription login; Martin's Max plan covers only trying an agent's prompt by hand in his own Claude Code session.
- **Two identical runs of `claude -p` send requests that differ only in `metadata.user_id`** (a session id). The system prompt also holds the date, the working directory and `git status`. A cassette key for agent calls leaves out the metadata and the date, and runners use a fixed working directory. Tool output that varies between runs, such as a test's timings, still ends a replay at that step.

Options to weigh:

- The gateway gains an Anthropic-shaped endpoint, since the Agent SDK in a runner holding no key needs `ANTHROPIC_BASE_URL` pointed at it. Behind it, providers: Anthropic now, a local one (LM Studio, no key, priced at nothing, still audited and capped), Bedrock in milestone 11. The provider is part of a cassette's key, so a local recording never stands in for Claude's.
- Which provider and model each agent uses, per profile, as a table in `policy/`. On `local`, a switch for unattended runs on the local model.
- The `local` overlay lets the gateway reach `0.250.250.254:1234`, and nothing else on the host.
- Cost levers, roughly in order of what they save: replaying unchanged calls and paying only from the first that differs; prompt caching passed through untouched (a cached read costs a tenth); Sonnet 5.5 at medium effort for the coder, Haiku 4.5 for small jobs, Opus 5.5 only where measured to help; a tight brief and a failing test from the planner, with turn limits; hand-written cassettes for testing the runner and sandbox; the Batch API's half price for evaluation sets; a spend limit on the Claude Console workspace behind the gateway's own caps.
- Priced at Sonnet 5.5, the Qwen run's tokens come to about $0.13. A real fix is probably 5 to 20 times larger: roughly $0.50 to $2.50 a run, to be measured.

### Coder, reviewer and describer

Options to weigh:

- **Skills are a harness feature, not a model's.** Claude Code and the Agent SDK put each skill's name and description in the system prompt and load the rest when it is used, so a runner on LM Studio gets the same skills and a local model follows them less well. A runner knows which step it is running, so it names the skill in the prompt rather than relying on the model to choose it.
- **[visual-pr](https://github.com/humanlayer/skills/tree/main/plugins/visual-pr/skills/visual-pr)** (MIT, built on show-me) is the starting point for descriptions: why in one sentence, what to look out for when there is anything, and the change's shape as `diff` blocks, file trees, call trees or Mermaid, only where they help. It commits, pushes and opens the pull request itself; the factory's copy, vendored at a pinned commit, only writes the description to a file, and drops the fixed headings.
- **Describing is a step of its own**, with a fresh context, once review has settled: the description is of the final diff, and the coder's context is full of dead ends. Its input is the ticket, the planner's spec, the diff, the review thread, and a short note of the coder's decisions. A smaller model may do.
- **The review loop**, within `COMPONENTS.md`'s reviewer as a non-required check that runs once the gates pass:
  1. The gates pass, and the reviewer posts a review through the App, each finding marked blocking or a suggestion, anchored to a line and citing its rule's number.
  2. The coder resumes its own session (the Agent SDK resumes sessions), keeping its understanding of the change; the cached prefix makes that cheap.
  3. It hands back a new patch, the gates run, and the reviewer reviews again. After a fixed number of rounds, perhaps two, anything still blocking goes to "Needs you".

  The review conversation on the pull request shows a reader how the work was done. Each round adds a reviewer run and a coder run to the work item's spend.
- **The reviewer reads `docs/REVIEWERS.md` from the base commit**, so a pull request cannot loosen the rules it is reviewed by.
- **The reviewer reviews the diff, not the shop.** The site is bad on purpose. It asks for nothing outside the ticket's scope, or the coder may fix other seeded defects in passing and muddle the scoreboard.
- **Findings are counted per rule** from the event store. A rule never cited can go; one cited often becomes a lint rule, or moves into `AGENTS.md` if it is an invariant.
