# Implement one work item to a pull request

You are a sub-agent. Your brief from the orchestrator names one work item in `mrogan/cv-software-factory`, its key, the run directory, the path to the scripts named below, and what is known about overlaps with other work. The work item is either:

- **an issue**: its key is the number (`278`), or `278-2` for its second pull request. Read it with `gh issue view <n>`;
- **a brief**: its key is a slug (`station-order`), and the work is described in `<run dir>/brief-<slug>.md`, written from a conversation with Martin you did not see. What it says was agreed is Martin's decision; what it leaves open is yours to settle.

A key that begins `app-` (`app-flag-context`) is a work item whose pull request is in the app's repository, `mrogan/cv-worlds-worst-website`: see [below](#a-work-item-in-the-apps-repository).

Martin won't answer questions. Make the calls you would otherwise ask for, and write each one down for your report.

## Ownership

- You alone own `scratch/worktrees/<key>` and its branch. `worktree.sh` refuses (exit 3) if either exists: then report `blocked`, unless your brief says you are taking it over.
- Nothing you start may outlive you. Run every command and every sub-agent in the foreground and wait for each to finish; leave no background task, watcher or sub-agent running. Your report is the last thing you do, and you change nothing after it.
- Leave the main checkout alone: other sessions use it.
- Never use `git stash` in any form: the stash is shared with the main checkout and every other worktree, so a pop can take another session's changes. Set work aside with a commit.

## A work item in the app's repository

The scripts read the repository from the key: `worktree.sh` makes the worktree from the app's checkout (beside this one, or `APP_DIR`), at the app's `origin/main`, still under this checkout's `scratch/worktrees/<key>`; `verify.sh` checks the app's pull request, CODEOWNERS and branch. Otherwise the steps below are the same, with these differences:

- **Nothing you write there mentions or hints at seeded defects or faults:** not in code, comments, tests, commits, branch names, the pull request, or replies to review. Describe a fix by what the code does wrong and what it does now. Your report to the orchestrator is not written there, and may say what it needs to.
- The new worktree has no dependencies, and sits inside this checkout, whose `node_modules` and `mise.toml` a command there would otherwise find: set it up first as the app's `AGENTS.md` says (`mise install && pnpm install`), in the worktree.
- Follow the app's `AGENTS.md` and `docs/REVIEWERS.md`, not this repository's, and run the app's `make check` (and anything else its `AGENTS.md` asks of a change like yours) in your worktree.
- Its `.github/CODEOWNERS` is the one that names the files that are Martin's.
- Name the repository in every `gh` command you run yourself (`-R mrogan/cv-worlds-worst-website`); the scripts take it from the key. The one exception is an issue (`app-<n>`), which is this repository's: read it with `gh issue view <n> -R mrogan/cv-software-factory`.
- The reviewer works in your worktree: give it the absolute path, and have it review `git -C <worktree> diff origin/main...HEAD` against the app's `docs/REVIEWERS.md`.
- The note's first line names your worktree as the checkout the branch is in, so `/visual-pr` reads the app's pull request template and recent descriptions. Run `gh pr create` in your worktree, and `.claude/skills/visual-pr/bin/check.ts --pr <pr>` there too, by this checkout's absolute path to it: it reads the pull request from the repository it runs in.
- For an issue (`app-<n>`), the issue is this repository's: the body says `Closes mrogan/cv-software-factory#<n>` or `Part of mrogan/cv-software-factory#<n>`.

A pull request that needs one in the other repository merged first (in either direction) says so in its description, naming it; the orchestrator orders them.

## Finish the item; don't file it away

Your job is to finish this item, not to find more work. Never open an issue.

- What the item needs to be done properly goes in this pull request: the docs and tests that change with it, comments it makes stale, and files CODEOWNERS gives Martin (below).
- If the item is right but too big or too mixed for one review, open a second pull request on it yourself, with every step below again, and report both as `pr-open`: `worktree.sh <key>-2 <branch>`, stacked on the first with a third argument only if it must be, and `Part of #<n>` for an issue.
- If finishing it needs work outside the item, stop at what is complete and report `split`, with each part you propose and why it cannot be part of this item.
- Something unrelated you notice (a fault that predates the change, a doc that is wrong elsewhere) goes under `found` in your report, with its file and line. The orchestrator decides what becomes of it.

## Files CODEOWNERS gives Martin

`.github/CODEOWNERS` lists the rules of the line, and a change to one merges only with Martin's approval. That is a reason to make the change well, not to avoid it: when the work needs one changed, change it in this pull request. Never leave one stale, or put off to an issue a change that belongs here.

Keep the change to what the work needs, and give each file a line in its own section of the pull request: what changed and why the work needs it. Say plainly if a change loosens a rule. `verify.sh` fails a pull request unless each such file it changes has a line in that section, under a heading that names CODEOWNERS, with words beside the path.

## Steps

1. **Worktree.** `worktree.sh <key> <type>/<short-name>` makes it from `origin/main` and prints its path. Work and commit only there.
2. **Triage.** Read the issue or the brief, and the code it names. Stop and report `skipped`, with a one-paragraph reason, if:
   - it is invalid, already done, or duplicates an open issue or pull request;
   - it needs a decision only Martin can make that neither the issue nor the brief settles (a change to the intent, a trade-off left open, a security flaw);
   - it can't merge on its own: it needs a new image pinned before a `deploy/` change, a migration with an ordered rollout, or a change to the local cluster to prove it. When your brief hands that part (the `deploy/` change, the proof) to the orchestrator, this is no reason to skip: build the rest, and name what you left under `decisions`.

   That a file is code-owned is never on its own a reason to skip.
3. **Implement.** Follow the repository's `AGENTS.md` and the docs it points to. Add or change tests to cover the change. `make check` passes before going on; run `make e2e` too if the console changed (snapshots only in the pinned image, `make e2e UPDATE=1`).
4. **Review.** A fresh sub-agent runs `/code-review medium <branch>`, always with the branch named, and you wait for it. Add `/security-review` if your brief asks for it, or if a mistake would be a security hole (auth, secrets, admission, anything reaching the network or the answer key). Brief each reviewer to give its findings as its final report to you, and to send them to no other agent. In a worktree `/security-review` gathers its diff from the main checkout and finds it empty, so give its reviewer your worktree's absolute path and have it review `git -C <worktree> diff <base>...HEAD`, where `<base>` is the base you give `/visual-pr` (`origin/main`, or the ref of the pull request below in a stack). Fix what holds up and belongs to the item; put the rest under `found`. Don't re-run the review on the fixes unless the change is fundamentally different.
5. **Pull request.** Write a note in `<run dir>/pr-<key>.md`, with the CODEOWNERS section above if it applies, then run `/visual-pr <base> <note>` and open the pull request with the description it returns, attaching each SVG and screenshot it lists with `--attach <path>`, on `gh pr create` and on any later `gh pr edit --body-file`, with the attribution folded as the skill's last lines show, and checking the published body with `node .claude/skills/visual-pr/bin/check.ts --pr <pr>` (in the app's worktree, for an `app-` key). The title is a Conventional Commit. An issue's body says `Closes #<n>`, or `Part of #<n>` when another pull request completes it (both with `mrogan/cv-software-factory` before the `#`, for an `app-` key); a brief's says what it does in its own right and names any issue it touches without closing it.
6. **Copilot.** Copilot reviews once, automatically, when the pull request opens, and may not review at all if it is out of credits. `copilot.sh <pr> <key>` waits for it and lists the unresolved threads with their ids. Copilot may take up to an hour from the opening, longer than one command runs, so `copilot.sh` waits at most eight minutes at a time: while it exits 5, run it again, in the foreground; exit 4 means Copilot did not review at all. Answer each of Copilot's with `reply.sh <thread-id> <body>`: fixed → name the commit, and it resolves; wrong → say why, and it resolves; arguable → reply with `--open`, and report it. A thread marked `NOT COPILOT` is someone else's: never resolve it; fix what it asks if it belongs to the item, reply with `--open`, and report it. Then read the review's summary, which `copilot.sh` prints after the threads: it can name findings that have no thread. Answer it once, with a comment on the pull request that begins `Copilot's review summary:` and quotes or names each finding the threads do not carry, each with fixed (the commit), wrong (why) or arguable (and report it); or says it adds nothing beyond the threads. Copilot reviews only once, so its verdict and counts of what "remains" are never updated: answer what it found, not its tally. Never request a review from Copilot or anyone else.
7. **Checks.** Wait for CI (`gh pr checks <pr> --watch`, with `-R` for an `app-` key). Fix a failure the change caused; report one it didn't. `main` takes a pull request only once its branch is up to date, so each merge puts the others behind, and Martin may bring one up to date himself with GitHub's "Update branch", which adds a merge commit to its branch. So before every push to a pull request, here or in step 6, and again before step 8 (pushing anything that leaves unpushed), `git fetch origin` and merge the worktree's own branch from `origin` into it, so a push neither fails nor overwrites his commit, and the worktree is at the pull request's head. If a push is still rejected, fetch and merge again; never force-push. When the pull request conflicts with `main`, or must be brought up to date, merge `origin/main` into the branch in the worktree too (a merge commit, so review threads keep their lines) and push, then wait for the checks again.
8. **Check yourself.** `verify.sh <key> <pr>` for each pull request (or `verify.sh <key>` when skipped) exits 0 before you report. It fails while Copilot may still review, so a report never goes ahead of Copilot's threads.

Never merge, approve, or push to `main`. Keep the worktree: it stays until Martin merges.

## Report

State only what command output showed you, and say plainly when a step was not finished. Report, and nothing more; repeat `pr` to `head` for a second pull request:

```
item:      #<n> | <slug>
outcome:   pr-open | split | skipped | blocked | incomplete
pr:        #<n> <url>
branch:    <name>
head:      <short sha of the pushed HEAD>
worktree:  scratch/worktrees/<key>
checks:    <from gh pr checks>
owned:     <each file CODEOWNERS gives Martin that changed, and why, or none>
threads:   <open arguable threads, with links, or none>
decisions: <each call made on Martin's behalf, a line each>
split:     <each part proposed beyond this item, and why it can't be part of it, or none>
found:     <each unrelated problem noticed, with file:line, or none>
reason:    <for split, skipped, blocked or incomplete>
```
