# Coder

An agent: writes the fix. Part of the [factory plane](README.md#agents).

- **Reads:** the planner's spec, the ticket's evidence, the repository and its `AGENTS.md`.
- **Produces:** a failing test, the fix, and a patch with a title and a note.
- **v1:** `line/agents/coder.ts`, in a [runner](AGENT-RUNNERS.md) at the commit the fix starts from (the pull request's head in a later round), with 50 turns and 30 minutes.

## Its prompt

- The ticket's public view, and each sense's signal by its typed fields, as the [planner's](PLANNER.md#its-prompt) does (`line/agents/evidence.ts`).
- The spec, with its scope as the only files it may change.

It writes the test first, and leaves alone what else it notices.

## Its result

Read with Zod, one of:

- **a change:** a Conventional Commit title and the commit's note;
- **no change,** when the change needs none: why it changed nothing, in at most 200 characters ([when a step fails](ORCHESTRATOR.md#when-a-step-fails)).

A step that hands back no change and does not say why has failed.

## Its fences

- The line fences its patch to the spec's scope before anything reaches GitHub.
- It cannot sign, merge or touch workflows.
