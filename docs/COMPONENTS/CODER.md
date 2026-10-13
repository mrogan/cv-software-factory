# Coder

An agent: writes the fix. Part of the [factory plane](README.md#agents).

- **Reads:** the planner's spec, the ticket's evidence, the repository and its `AGENTS.md`.
- **Produces:** a failing test, the fix, and a patch with a title and a note.
- **v1:** `line/agents/coder.ts`, in a [runner](AGENT-RUNNERS.md) at the commit the fix starts from (the pull request's head in a later round), with 50 turns and 30 minutes.

## Its prompt

- The ticket's public view, and each sense's signal by its typed fields, as the [planner's](PLANNER.md#its-prompt) does (`line/agents/evidence.ts`).
- The spec, with its scope as the only files it may change.
- In a later round sent back by review, the review's blocking findings and its suggestions, numbered.

It writes the test first, and leaves alone what else it notices.

## Its result

Read with Zod, one of:

- **a change:** a Conventional Commit title and the commit's note, with the suggestions it declined;
- **no change,** when the change needs none: why it changed nothing, in at most 200 characters ([when a step fails](ORCHESTRATOR.md#when-a-step-fails)), declining every suggestion it was given, so no thread outlives Martin's answer;
- **every suggestion declined,** in a round sent back for an approval's suggestions alone: nothing changed, and the approval stands.

A step that hands back no change and does not say why has failed.

## Suggestions

The coder answers the reviewer's suggestions as the factory asks of any agent answering a review: it takes each, changing the code for it, or declines it with a reason (`declined`: its number and why, in at most 300 characters). Each suggestion is answered once.

- **One declined** has its thread answered with the coder's reason and resolved by the [GitHub worker](GITHUB-WORKER.md), once the round is pushed. The next reviewer is told it, with the reason, and gives it again only if the reason does not hold.
- **One taken** is the next reviewer's to find taken; its thread is resolved then ([reviewer](REVIEWER.md#what-the-line-does-with-it)).

The line records the answer as `suggestions.answered`.

## Its fences

- The line fences its patch to the spec's scope before anything reaches GitHub.
- It cannot sign, merge or touch workflows.
