# Describer

An agent: describes the fix once review approves it. Part of the [factory plane](README.md#agents).

- **Reads:** the ticket's public view and what the senses saw, the spec, the final diff and the coder's commit messages, and the review thread, round by round.
- **Produces:** the pull request's title and description, and the work item's summary (`work-item.summarised`).
- **v1:** `line/agents/describer.ts`, in a [runner](AGENT-RUNNERS.md) at the pull request's head with its base beside it, with a fresh context, 30 turns and 15 minutes.

## Its skill

It names the runner's `visual-pr` skill (vendored from HumanLayer under MIT, `apps/runner/plugin`), which:

- fits a description to its change: a line, if a line will do, and a few points for a small change;
- lays it out to scan: the opening sentence alone, then one point to a bullet;
- folds what supports the story, such as the tests and the rollout, into `<details>` sections with a `##` heading in each summary;
- reads the repository's pull request template as questions to answer, not headings to fill.

Martin's own `/visual-pr` follows the same skill, so the line's descriptions are written to his rules.

## Its result

Read with Zod:

- **the description,** written as a Markdown file beside its result;
- **the title,** a Conventional Commit of 80 characters at most;
- **the summary:** a title, two lines for the card, and the paragraph at the top of the sheet.

The squash commit takes the description as its message, so the schema refuses:

- a closing keyword before an issue, which would close the ticket's issue on merge rather than once the fix is verified;
- an @mention outside code;
- a folded section that would not render, read line by line (`line/agents/folds.ts`): GitHub shows the Markdown in a `<details>` as text unless a blank line ends the HTML before it.

A refused result runs the step again, told why.

## What the line does with it

1. It sets the pull request's title and description, with the line that refers to the ticket's issue, then takes it out of draft, each once for a handback.
2. It appends the summary.

Then the work item waits for Martin's merge.
