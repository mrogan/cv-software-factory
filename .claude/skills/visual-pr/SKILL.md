---
name: visual-pr
description: Write a pull request's description from its branch, in a context of its own, and return the file it wrote. Use before opening a pull request in this repository or the app's, and again when review changes the shape of the change.
argument-hint: "<base ref> <note file>"
context: fork
agent: general-purpose
background: false
---

# Describe a pull request, in a fresh context

You run in a context of your own. You have not seen the session that made this change: the code tells you what changed, and the note tells you why. Arguments: `$ARGUMENTS`, which are, in order:

1. **The base**: the branch the pull request merges into, `origin/main` or, in a stack, the pull request below it.
2. **The note**: a short file from whoever made the change. It says why the change exists, the decisions it took and the ones it turned down, what it left out and where that went, and how it was tested. Its first lines name the checkout the branch is in, when that is not this repository (a pull request to the app), and the plan's task, when there is one: read that task in `docs/PLAN/`.

## Steps

1. Read `apps/runner/plugin/skills/visual-pr/SKILL.md` and follow it. It is the factory's describer, vendored with its licence, and this skill runs it for people's pull requests without changing it, so the line's cassettes stay valid. Where it differs:
   - What "the step gives you" is the note and the plan's task.
   - `base` is the base above, in the note's checkout: the diff is `git diff <base>...HEAD`, the commits `git log <base>..HEAD`, and the template `git show <base>:.github/pull_request_template.md`.
   - Its `references/show-me.md` is beside it, in `apps/runner/plugin/skills/visual-pr/references/`.
   - Write the description to this repository's `scratch/pr/<branch>.md`, with any `/` in the branch's name made `-`. `scratch/` is ignored by git.
2. Answer with the file's path and one line on the description's shape. Do not repeat the description: keeping it out of the caller's context is why this skill runs on its own.

Do not commit, push, or open or edit a pull request. Whoever called you writes the title, adds the attribution lines, and opens the pull request with `gh pr create --body-file`, or updates it with `gh pr edit --body-file`.
