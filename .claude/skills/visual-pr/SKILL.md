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
2. When the diff changes images the repository keeps (the console's visual snapshots in `apps/console/e2e/snapshots/`, or any other committed `.png`), show the change: a reviewer should see it before reading about it.
   - List them with `git diff --name-status --find-renames --diff-filter=AMR <base>...HEAD -- '*.png'`: `A` is new, `M` changed, and `R` renamed, with its old path then its new one. Look at the versions each candidate has (`git show <base>:<old path>`, for `M` and `R` only, and `git show HEAD:<path>`, saved to your scratchpad, then read) and choose the few that show the change best: up to four, at one width unless widths behave differently, one theme unless the themes do; one is enough when it is all there is. Say in a line how many others changed and that they change the same way, or what else they show.
   - Put them under the description's opening, before the prose that explains them, as a two-column table, Before and After, one row each, with a caption naming what the reviewer should look at. An image wider than a card or a panel goes one under the other instead, so it is not shrunk past reading. A snapshot that is new has no Before: show it alone. A renamed one's Before is at its old path.
   - Link each by its commit, as GitHub serves a file: `https://github.com/<owner>/<repo>/blob/<sha>/<path>?raw=true`, where `<owner>/<repo>` is the note's checkout (`gh repo view --json nameWithOwner -q .nameWithOwner`), Before is at `git rev-parse <base>` and After at `git rev-parse HEAD`. A commit's link keeps working after a squash merge, because the pull request keeps its commits. Give every image alt text that says what it shows.
3. Answer with the file's path and one line on the description's shape. When it has pictures, say that they show only once `HEAD` is pushed, and that a later push leaves them showing the commit they name: run this skill again when review changes what the pictures show. Do not repeat the description: keeping it out of the caller's context is why this skill runs on its own.

Do not commit, push, or open or edit a pull request. Whoever called you writes the title, adds the attribution lines, and opens the pull request with `gh pr create --body-file`, or updates it with `gh pr edit --body-file`.
