# Implement one work item to a pull request

You are a sub-agent. Your brief from the orchestrator names one work item in `the-roganator/cv-software-factory`, its key, the run directory, the path to the scripts named below, and what is known about overlaps with other work. The work item is either:

- **an issue**: its key is the number (`278`), or `278-2` for its second pull request. Read it with `gh issue view <n>`;
- **a brief**: its key is a slug (`station-order`), and the work is described in `<run dir>/brief-<slug>.md`, written from a conversation with Martin you did not see. What it says was agreed is Martin's decision; what it leaves open is yours to settle.

A key that begins `app-` (`app-flag-context`) is a work item whose pull request is in the app's repository, `the-roganator/cv-worlds-worst-website`: see [below](#a-work-item-in-the-apps-repository).

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
- Name the repository in every `gh` command you run yourself (`-R the-roganator/cv-worlds-worst-website`); the scripts take it from the key. The one exception is an issue (`app-<n>`), which is this repository's: read it with `gh issue view <n> -R the-roganator/cv-software-factory`.
- The reviewer works in your worktree: give it the absolute path, and have it review `git -C <worktree> diff <base>...HEAD`, where `<base>` is `origin/main` or, in a stack, `origin/<branch below>`, against the app's `docs/REVIEWERS.md`.
- The note's first line names your worktree as the checkout the branch is in, so `/visual-pr` reads the app's pull request template and recent descriptions. Run `gh pr create` and `gh stack link` in your worktree, and `.claude/skills/visual-pr/bin/check.ts --pr <pr>` there too, by this checkout's absolute path to it: it reads the pull request from the repository it runs in.
- For an issue (`app-<n>`), the issue is this repository's: the body says `Closes the-roganator/cv-software-factory#<n>` or `Part of the-roganator/cv-software-factory#<n>`.

A pull request that needs one in the other repository merged first (in either direction) says so in its description, naming it; the orchestrator orders them.

## Finish the item; don't file it away

Your job is to finish this item, not to find more work. Never open an issue.

- What the item needs to be done properly goes in this pull request: the docs and tests that change with it, comments it makes stale, and files CODEOWNERS gives Martin (below).
- If the item is right but too big or too mixed for one review, open a second pull request on it yourself, with every step below again, and report both as `pr-open`: `worktree.sh <key>-2 <branch>`, and `Part of #<n>` for an issue. If it builds on the first's unmerged work, stack it on the first, as [Stacks](#stacks) says; if it does not, branch it from `origin/main`.
- If finishing it needs work outside the item, stop at what is complete and report `split`, with each part you propose and why it cannot be part of this item.
- Something unrelated you notice (a fault that predates the change, a doc that is wrong elsewhere) goes under `found` in your report, with its file and line. The orchestrator decides what becomes of it.

## Files CODEOWNERS gives Martin

`.github/CODEOWNERS` lists the rules of the line, and a change to one merges only with Martin's approval. That is a reason to make the change well, not to avoid it: when the work needs one changed, change it in this pull request. Never leave one stale, or put off to an issue a change that belongs here.

Keep the change to what the work needs, and give each file a line in its own section of the pull request: what changed and why the work needs it. Say plainly if a change loosens a rule. `verify.sh` fails a pull request unless each such file it changes has a line in that section, under a heading that names CODEOWNERS, with words beside the path.

## Steps

A brief that says build-only stops after step 3, as [Build-only](#build-only) says; one that says to finish a branch already built starts there too.

1. **Worktree.** `worktree.sh <key> <type>/<short-name>` makes it from `origin/main` and prints its path; a third argument, `origin/<branch below>`, makes it from that branch instead, for a pull request in a [stack](#stacks). Work and commit only there.
2. **Triage.** Read the issue or the brief, and the code it names. Stop and report `skipped`, with a one-paragraph reason, if:
   - it is invalid, already done, or duplicates an open issue or pull request;
   - it needs a decision only Martin can make that neither the issue nor the brief settles (a change to the intent, a trade-off left open, a security flaw);
   - it can't merge on its own: it needs a new image pinned before a `deploy/` change, a migration with an ordered rollout, or a change to the local cluster to prove it. When your brief hands that part (the `deploy/` change, the proof) to the orchestrator, this is no reason to skip: build the rest, and name what you left under `decisions`.

   That a file is code-owned is never on its own a reason to skip.
3. **Implement.** Follow the repository's `AGENTS.md` and the docs it points to. Add or change tests to cover the change. `make check` passes before going on; run `make e2e` too if the console changed (snapshots only in the pinned image, `make e2e UPDATE=1`).
4. **Review.** A fresh sub-agent runs `/code-review medium <branch>`, always with the branch named, and you wait for it. Add `/security-review` if your brief asks for it, or if a mistake would be a security hole (auth, secrets, admission, anything reaching the network or the answer key). Brief each reviewer to give its findings as its final report to you, and to send them to no other agent. In a worktree `/security-review` gathers its diff from the main checkout and finds it empty, so give its reviewer your worktree's absolute path and have it review `git -C <worktree> diff <base>...HEAD`, where `<base>` is the base you give `/visual-pr` (`origin/main`, or the ref of the pull request below in a stack). Fix what holds up and belongs to the item; put the rest under `found`. Don't re-run the review on the fixes unless the change is fundamentally different.
5. **Pull request.** Write a note in `<run dir>/pr-<key>.md`, with the CODEOWNERS section above if it applies, then run `/visual-pr <base> <note>` and open the pull request with the description it returns, attaching each SVG and screenshot it lists with `--attach <path>`, on `gh pr create` and on any later `gh pr edit --body-file`, with the attribution folded as the skill's last lines show, and checking the published body with `node .claude/skills/visual-pr/bin/check.ts --pr <pr>` (in the app's worktree, for an `app-` key). The title is a Conventional Commit. An issue's body says `Closes #<n>`, or `Part of #<n>` when another pull request completes it (both with `the-roganator/cv-software-factory` before the `#`, for an `app-` key); a brief's says what it does in its own right and names any issue it touches without closing it.
6. **Copilot.** Copilot reviews once, automatically, when the pull request opens, and may not review at all if it is out of credits. `copilot.sh <pr> <key>` waits for it and lists the unresolved threads with their ids. Copilot may take up to an hour from the opening, longer than one command runs, so `copilot.sh` waits at most eight minutes at a time: while it exits 5, run it again, in the foreground; exit 4 means Copilot did not review at all. Answer each of Copilot's with `reply.sh <thread-id> <body>`: fixed → name the commit, and it resolves; wrong → say why, and it resolves; arguable → reply with `--open`, and report it. A thread marked `NOT COPILOT` is someone else's: never resolve it; fix what it asks if it belongs to the item, reply with `--open`, and report it. Then read the review's summary, which `copilot.sh` prints after the threads: it can name findings that have no thread. Answer it once, with a comment on the pull request that begins `Copilot's review summary:` and quotes or names each finding the threads do not carry, each with fixed (the commit), wrong (why) or arguable (and report it); or says it adds nothing beyond the threads. Copilot reviews only once, so its verdict and counts of what "remains" are never updated: answer what it found, not its tally. Never request a review from Copilot or anyone else.
7. **Checks.** Wait for CI (`gh pr checks <pr> --watch`, with `-R` for an `app-` key). Fix a failure the change caused; report one it didn't. `main` takes pull requests through GitHub's merge queue, which tests each on `main` as it will be, so a branch behind `main` needs nothing: never merge `origin/main` into it only to bring it up to date. Before every push to a pull request, here or in step 6, and again before step 8 (pushing anything that leaves unpushed), `git fetch origin` and merge the worktree's own branch from `origin` into it, so a push neither fails nor overwrites a commit someone else added, and the worktree is at the pull request's head. If a push is still rejected, fetch and merge again; never force-push. Only when the pull request conflicts with `main`, which the queue cannot take, or, in a stack, when the branch below changes, merge `origin/main` (in a stack, `origin/<branch below>`, as [Stacks](#stacks) says) into the branch in the worktree (a merge commit, so review threads keep their lines), resolve it and push, then wait for the checks again.
8. **Check yourself.** `verify.sh <key> <pr>` for each pull request (or `verify.sh <key>` when skipped) exits 0 before you report. It fails while Copilot may still review, so a report never goes ahead of Copilot's threads.

Never merge, approve, or push to `main`, and never enqueue a pull request or a stack. Keep the worktree: it stays until Martin merges.

## Build-only

Work that changes what runs on the cluster is tried there before anyone reviews it (the implement skill's [Try before review](SKILL.md#try-before-review)). When your brief says build-only:

- Do steps 1 to 3: the worktree (stacked on the branch below, as [Stacks](#stacks) says), triage, and the implementation, with its tests and `make check` green, and `make e2e` if the console changed. Commit, `git fetch origin`, merge the branch from `origin` if it is there, and push it, so the branch above yours can be made from it and the orchestrator can build its images.
- Then stop: no code review or security review, no note, no `/visual-pr`, no pull request, no Copilot. Report `built`, with the branch and its pushed head, and `none` for `pr`, `stack`, `checks` and `threads`: `verify.sh` has nothing to check yet.
- A fault the try found comes back to you, or to a new worker on your worktree, build-only again: `git fetch origin` and merge the branch from `origin` first, since the branch below may have been merged into it, fix it with a test that shows it, push, and report `built` again.

When your brief says the try has passed and you are to finish a branch already built, the worktree and the branch exist: take the worktree as your own (`worktree.sh` would refuse, so do not run it), `git fetch origin` and merge the branch from `origin`, and the branch below if it changed, as step 7 says. Read what is on the branch, the fixes the try sent back included, and check `make check` passes again, and `make e2e` if the console changed. Then do steps 4 to 8 as for any pull request: both reviews of the whole branch, the note, which says what the try showed, `/visual-pr`, the pull request, Copilot, the checks and `verify.sh`, and report `pr-open`.

## Stacks

A stack is for pull requests that build on each other's unmerged work, and only for that: independent work branches from `origin/main`. Stacks work with the merge queue and the review gate in both repositories ([ADR 0014](../../../docs/architecture/adr/0014-merge-queue-and-review-gate.md)); there is nothing to check first. A stack never spans the two.

- Make the worktree from the branch below, with `worktree.sh`'s third argument (`origin/<branch below>`), and give `origin/<branch below>` to `/visual-pr` as the base, and to `/code-review` and `/security-review` as the diff's base, and its name, `<branch below>`, to `gh pr create --base`.
- The description names the pull request below. Once it is open, link it into the stack: `gh stack link <bottom> … <top>`, with the pull requests' numbers, bottom first, or `gh stack link <stack> <pr>` to add it to the top of a stack already linked. If `gh stack` is missing, `gh extension install github/gh-stack`. Put the stack's number in your report.
- When the branch below yours changes, merge `origin/<branch below>` into yours (a merge commit) and push, as step 7 says; only the bottom branch takes `origin/main`. The branches above yours are their own workers': leave them to the orchestrator. Never rebase or force-push, so not `gh stack sync` or `gh stack rebase`, which do both.

## Report

State only what command output showed you, and say plainly when a step was not finished. Report, and nothing more; repeat `pr` to `head` for a second pull request. For `built`, `pr`, `stack`, `checks` and `threads` are `none`:

```
item:      #<n> | <slug>
outcome:   pr-open | built | split | skipped | blocked | incomplete
pr:        #<n> <url>, or none for built
stack:     <its number and the pull requests in it, bottom first, or none>
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
