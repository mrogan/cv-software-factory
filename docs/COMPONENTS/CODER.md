# Coder

An agent: writes the fix, or builds an improvement behind its flag. Part of the [factory plane](README.md#agents).

- **Reads:** the planner's spec, the ticket's evidence or Martin's request, the repository and its `AGENTS.md`.
- **Produces:** a failing test, the fix, and a patch with a title and a note.
- **v1:** `line/agents/coder.ts`, in a [runner](AGENT-RUNNERS.md) at the commit the fix starts from (the pull request's head in a later round), with 50 turns and 30 minutes.

## Its prompt

- The ticket's public view, and each sense's signal by its typed fields, as the [planner's](PLANNER.md#its-prompt) does (`line/agents/evidence.ts`).
- The spec, with its scope as the only files it may change.
- In a later round sent back by review, the review's blocking findings and its suggestions, numbered.

For an improvement, Martin's words in place of the ticket, and the spec with its flag, its pages and each criterion's side of the flag, and:

- **Every new behaviour behind the flag,** read as `await request.flag('<flag>')`, as the app's `AGENTS.md` says, and nowhere else, so that with it off the app is as it was.
- **The flag defined nowhere:** one the flag service does not name is off, so the change ships off.
- **Each criterion's test with the flag as its side says,** stubbing the request's `flag` as the app's own tests do (`flag: async () => false`, or true for the flag named).
- **Never the flag context, `src/flags/`,** and nothing kept on a visitor's device.

It writes the test first, and leaves alone what else it notices. Before it hands back, it runs what the app's CI requires of a change, lint and formatting, the type check and the tests, by the commands the app's `make check` runs, since the runner has no `make`, and leaves out the manifests, which it has no renderer for, saying in its note what it left out. It puts right only what its change caused, and a file the formatter refuses by the formatter alone, so a lint fix does not widen the patch. A change the gates would refuse for its formatting or a type error does not cost a round. A later round that resumes its session and changes something is reminded to run them again.

## Its result

Read with Zod, one of:

- **a change:** a Conventional Commit title, of type `fix`, `test`, `refactor` or `perf` for a fix and `feat` for an improvement, and the commit's note, with the suggestions it declined;
- **no change,** when the change needs none: why it changed nothing, in at most 200 characters ([when a step fails](ORCHESTRATOR.md#when-a-step-fails)), declining every suggestion it was given, so no thread outlives Martin's answer;
- **every suggestion declined,** in a round sent back for an approval's suggestions alone: nothing changed, and the approval stands. A change's title and note that come with every suggestion declined and no patch are taken the same way.

A step that hands back no change and does not say why has failed.

## Suggestions

The coder answers the reviewer's suggestions as the factory asks of any agent answering a review: it takes each, changing the code for it, or declines it with a reason (`declined`: its number and why, in at most 300 characters). Each suggestion is answered once.

- **One declined** has its thread answered with the coder's reason and resolved by the [GitHub worker](GITHUB-WORKER.md), once the round is pushed. The next reviewer is told it, with the reason, and gives it again only if the reason does not hold.
- **One taken** is the next reviewer's to find taken; its thread is resolved then ([reviewer](REVIEWER.md#what-the-line-does-with-it)).

The line records the answer as `suggestions.answered`.

## Its fences

- The line fences its patch to the spec's scope before anything reaches GitHub.
- It cannot sign, merge or touch workflows.
