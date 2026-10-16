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
   - Write the description to this repository's `scratch/pr/<branch>.md`, in the main checkout (`$(git rev-parse --path-format=absolute --git-common-dir)/..`) even when you run in a worktree of it, with any `/` in the branch's name made `-`. `scratch/` is ignored by git.
2. When the diff changes images the repository keeps (the console's visual snapshots in `apps/console/e2e/snapshots/`, or any other committed `.png`), show the change: a reviewer should see it before reading about it.
   - List them with `git diff --name-status --find-renames --diff-filter=AMR <base>...HEAD -- '*.png'`: `A` is new, `M` changed, and `R` renamed, with its old path then its new one. Look at the versions each candidate has (`git show <fork>:<old path>`, for `M` and `R` only, where `<fork>` is `git merge-base <base> HEAD`, the commit the diff starts from, and `git show HEAD:<path>`, saved to your scratchpad, then read) and choose the few that show the change best: up to four, at one width unless widths behave differently, one theme unless the themes do; one is enough when it is all there is. Say in a line how many others changed and that they change the same way, or what else they show.
   - Show a changed or renamed one as one picture that blinks between Before and After, so the change is what moves: `node .claude/skills/visual-pr/bin/blink.ts <before.png> <after.png> <svg>` writes it, with a band that says which is showing. Write each SVG to this repository's `scratch/pr/<branch>/`, `/` made `-` as for the description, beside it, named after its snapshot, and nothing else there: the PNGs stay in your scratchpad. Reference it by its absolute path: the caller attaches it, and `gh` uploads it and rewrites the path to where GitHub keeps it. A renamed one's Before is at its old path. A snapshot that is new has no Before: show it alone, linked by its commit, as GitHub serves a file: `https://github.com/<owner>/<repo>/blob/<head sha>/<path>?raw=true`.
   - Wrap each blink in a link to the snapshot's own diff, `[![<alt>](<svg>)](https://github.com/<owner>/<repo>/compare/<fork>...<head sha>#diff-<sha256 of the path>)`, where GitHub shows the two side by side, as a swipe and as an onion skin. Opened alone the SVG shows its bands and no pictures, because GitHub serves it under a policy that blocks the pictures inside it, so the link is what a click needs. `<owner>/<repo>` is the note's checkout (`gh repo view --json nameWithOwner -q .nameWithOwner`), `<head sha>` is `git rev-parse HEAD`, and the path's hash is `printf %s <path> | shasum -a 256`. Commits' links keep working after a squash merge, because the pull request keeps its commits, and `<fork>` is on GitHub because the base is.
   - Put them under the description's opening, before the prose that explains them, one under the other, each with a caption naming what the reviewer should look at. Give each alt text that says what it shows, and for a blink what changes between the two.
3. Keep it short, and fold away what supports the story.
   - A reviewer reads the description before the diff, and stops reading once it stops helping. Leave out what the diff shows plainly (each file touched, each test added, a setting's exact value) and what only says the process happened, and keep what it cannot: why, what was decided and turned down, and what to look at first. Cut a detail rather than a reason.
   - In the open, at the top: why, the pictures, what not to miss, the views that explain the change, and what was turned down, briefly. A supporting section (tests, known limits, rollout, overlaps with other work, code-owned files) is a collapsed section of its own, when it has anything to say: a `<details>` whose `<summary>` holds a `##` heading, so it reads as a heading that folds. Name these sections plainly (Tests, Known limits, Rollout, Overlaps, Code-owned files), the same in every description, so a reviewer knows where to look: they are the one fixed vocabulary, and the story's headings, when it needs any, are still named for the change. GitHub keeps Markdown inside an HTML block as text until a blank line ends the block, so the blank lines are what make it render: one after `<summary>`, one before `</summary>`, one after it, and one before `</details>`.

     ```markdown
     <details>
     <summary>

     ## Tests

     </summary>

     - The body: lists, code, tables and diagrams render as they do anywhere.

     </details>
     ```

   - Open a section with `<details open>` when a reviewer needs it before judging the change, and leave it closed when they would read it only to check. Code-owned files are always open: they merge only with Martin's approval, and he reads them first. Overlaps, written for whoever works next to the change, are almost always closed. Known limits and rollout are closed unless one changes what a reviewer would do. Tests are closed when they are the usual automated ones, and what the testing showed belongs in the story above.
   - Check it renders: `node .claude/skills/visual-pr/bin/check.ts <file>` renders it with GitHub's own renderer, which publishes nothing, and names each section that broke and any Markdown left as text. Fix what it names until it exits 0.
4. Answer with the file's path and one line on the description's shape. When it has pictures, list the SVGs by their absolute paths, and say that the links show only once `HEAD` is pushed, and that a later push leaves the pictures as they are: run this skill again when review changes what they show. Do not repeat the description: keeping it out of the caller's context is why this skill runs on its own.

Do not commit, push, or open or edit a pull request. Whoever called you writes the title, and adds the attribution lines as a collapsed section of their own at the very end, the first line as a small heading in the summary and the rest as its body:

```markdown
<details>
<summary>

###### 🤖 Generated with [Claude Code](https://claude.com/claude-code)

</summary>

<the rest of the attribution, such as the session's link>

</details>
```

Then they open the pull request with `gh pr create --body-file`, or update it with `gh pr edit --body-file`. Either way, with pictures, they pass `--attach <svg>` for each SVG you list, spelled as you list it. Then `node .claude/skills/visual-pr/bin/check.ts --pr <pr>` checks the published body: what it renders, and that no local path is left, which would be a broken picture that shows the world where this checkout lives.
