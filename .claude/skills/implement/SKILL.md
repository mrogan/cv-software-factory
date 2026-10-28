---
name: implement
description: Take issues, or a part of this conversation, to pull requests ready for Martin to merge, one sub-agent at a time, each report checked before it is believed.
argument-hint: "#123 [#456 …] | <what from this conversation>"
disable-model-invocation: true
---

# Implement work items to pull requests

The work: `$ARGUMENTS`. It is one or more issues (`#123`, `#123, #456`), something from this conversation (`the station order part`), or a mix. Take each to open pull requests that are ready for Martin to merge, or skip it with a reason.

You are the orchestrator. Keep your context lean: sub-agents do the work, each following [`worker.md`](worker.md). Make the calls you would otherwise ask Martin for, and write each one down. The scripts are in `${CLAUDE_SKILL_DIR}/bin/`; give sub-agents that absolute path, since their worktrees may not have this skill.

## Before starting

1. **Key each work item.** An issue's key is its number. Something from the conversation is a brief, and its key is a short slug (`station-order`). An issue's second pull request is `<n>-2`. A work item whose pull request is in the app's repository (`the-roganator/cv-worlds-worst-website`, checked out beside this one) has a key that begins `app-` (`app-flag-context`, or `app-<n>` for this repository's issue `<n>`): the scripts read the repository from the key, and the prefix keeps its worktree apart from this repository's under `scratch/worktrees/`.
2. **Make the run directory**: `run.sh <key>...` makes `scratch/implement/<date>-<keys>/` and prints its path. Notes, briefs, PR notes and the summary go there. A run that spans sessions (a milestone's part, with Martin merging between them) keeps two files there as well, which each session reads first and updates last, so that the run's state lives in files a later session can take up. A later session takes up the same run directory, named in its handover, rather than making a new one:
   - `LEDGER.md`: a row per work item, with its state, pull requests, what it waits on, and the next action;
   - `FOLLOWUPS.md`: each loose end the moment it is found (a `found`, a workflow problem, something only Martin can do), with where it goes, emptied at the end of each work item.

   What waits on Martin, and what to try, the session tells him in its reply: the pull requests to merge, in order, with what to look at in each, and what to try once one is deployed.
3. **Write each brief from the conversation** to `<run dir>/brief-<slug>.md`. The sub-agent sees nothing of this conversation, so the brief stands alone:
   - **Goal**: the change, and why, in a paragraph;
   - **Agreed**: every decision Martin made or accepted, in Martin's terms, and every option turned down;
   - **Scope**: the files, components and docs named, and what is explicitly out;
   - **Open**: anything left undecided, which the sub-agent settles and reports;
   - **Related**: issues, pull requests and commits named.

   A brief for a work item in the app's repository also carries this rule, in these words: nothing written in the app's repository, in code, commits, branch names, pull requests or replies, mentions or hints at seeded defects or faults.

   Write down what was said, not what you would add. If the conversation left open a decision that changes what gets built, ask Martin now, in one question, while he is here.

   For work that changes what runs on the cluster, design it by tracing the whole path it opens, not only the part it changes: what runs after it, with what input, and whether that has ever run. A part of the path that never has is named in the brief, and in the try's proof ([Try before review](#try-before-review)).
4. **Read every issue** far enough to brief it. Note work items that touch the same files or depend on each other, and order them so that one another builds on goes first. Independent work items each branch from `origin/main`, and merge in any order. Where pull requests build on each other's unmerged work (an item split into parts that build on one another, or an item that needs another's unmerged change), stack them, as [Stacks](#stacks) says, rather than wait for Martin to merge the one below; tell the worker the branch to build on. When several work items need the same piece (a component, a helper they all reuse), make that piece a small work item of its own, branched from `origin/main` and done first. A GitHub stack is one chain, so only one item can stack on the piece: the first that uses it. The others branch from `main` once the piece merges, which Martin can do quickly for a small piece; don't chain independent items above it just to start them sooner. A pull request that needs one in the other repository merged first cannot stack on it: its description says so, and you order them, the merge order and any `deploy/` pin between, in the summary.

## Try before review

Reviews pass faults that only running the work shows, and a fault in one part of a task often shows only once the part before it runs. So work that changes what runs on the cluster (the line, its agents, the workers, the console's actions) is tried on the local cluster before anyone reviews it, and reviewed once, after:

1. **Build.** Brief each worker in build-only mode ([`worker.md`](worker.md#build-only)): it builds its branch, stacked on the one below as [Stacks](#stacks) says, with its tests and `make check` green, and stops. No pull request, no code review or security review, no `/visual-pr`, no Copilot yet. It reports `built`, with its branch and head; verify that `git ls-remote origin <branch>` shows that head, and log it.
2. **Try.** Once every part is built, make every branch current: `origin/main` merged into the bottom and each branch into the one above, bottom first, as [Stacks](#stacks) says, so the images tried are what will merge. Then build the images from the top branch, which holds every part below it, and run the plan's proof, or the brief's, with the `try-the-line` skill on local images, time-boxed. Send each fault back to the branch it belongs in, to a worker briefed with what the try showed (build-only again; the worker who built it, or a new one on its worktree), merge it upwards through the branches above, as [Stacks](#stacks) says, and try again, until the proof passes. Log each try, what it showed and where each fault went, in `NOTES.md`.
3. **Batch Martin's part.** What needs a passkey (an answer to a hold, an approval in the console) is put into one short sitting with him, with a list of what to do and what to look for, not asked for one at a time. Where an agent's step is what is being tried, try it on the bench first, against its throwaway store, where no passkey is needed; only what the bench cannot show (what the line folds from a work item's events, or the commit it picks) needs the cluster, as `try-the-line` says.
4. **Finish.** Once the proof passes, send each worker, bottom first, to finish its pull request as `worker.md` says for a branch already built: both reviews, `/visual-pr` and the pull request, then Copilot, once each, answered across the stack in one pass as [Stacks](#stacks) says. Its description says what the try showed, at which head, and what review changed since. Then the stack is Martin's to merge, and the try on the cluster after the deploy is his, as [Work a worker cannot do](#work-a-worker-cannot-do) says.

Try a part early, alone, only when a later part's design turns on what it shows (usually an agent's behaviour, which the bench shows in minutes), or when the parts are independent: then each is tried, and finished, on its own. Work with nothing to see on the cluster (docs, a test, CI, a skill) skips the try and goes straight to its pull request.

## Each work item, one at a time

1. **Brief** a fresh sub-agent to follow `${CLAUDE_SKILL_DIR}/worker.md`, with the key, the issue or the brief's path, the run directory, the scripts' path, and what you know about overlaps with the other work items and their pull requests. For work to try before review, say build-only, or, after the try, that it finishes a branch already built, with what the try showed.
2. **Wait for it to end, not only to report.** A sub-agent can hand back its report while its own background work is still running, and resume afterwards. Go on only when its task notification says it finished with nothing of its own still running, and `ListAgents` shows neither it nor anything it started still running; `TaskStop` any that is. A reviewer a worker started may send its findings to you by mistake: forward them, with SendMessage, to the worker that owns the pull request. If it has already reported, its report stands only once it has dealt with them: verify and log it again.
3. **Verify** before you log or say anything: `verify.sh <key> <pr>` for each pull request, or `verify.sh <key>` for a skip; for a `built` report, that `git ls-remote origin <branch>` shows its head, and that it has no pull request yet; for an `opened` one, that `verify.sh <key> <pr>` fails only because Copilot has not reviewed yet. If the report and the script disagree, the script wins: log what is true, and say so. A pull request is not ready while Copilot may still review, and `verify.sh` says so.
4. **Settle what it handed back.** A `split` or a `found` is yours to decide, not the sub-agent's (see below).
5. **Log** the verified outcome and your decisions in `<run dir>/NOTES.md`.
6. **Retry or move on.** A sub-agent that failed, stopped partway or reported something untrue is stopped before anything else touches its worktree. A new sub-agent may take the worktree over, briefed with what is actually there; otherwise note it and go on.

Never run two sub-agents at once, and never give a worktree to a second agent while the first can still run.

Pull requests merge through GitHub's merge queue, which tests each on `main` as it will be, so one that falls behind `main` needs nothing. When Martin merges one, move only what that merge forces: a pull request that now conflicts with `main`, which the queue cannot take. Send a sub-agent to fetch and merge `origin/main` into it and resolve, briefed with what merged: it owns the worktree for that, as the first did. Where the merge conflicts on the merged pull request's own changes, it starts from `main`'s side, which carries that pull request as reviewed, and carries its own pull request's changes over onto it. In a stack, the branches above it then take the change bottom first, as [Stacks](#stacks) says. Once its checks pass and `verify.sh` passes again, tell Martin it is ready to merge.

A pull request marked `Part of #<n>` closes nothing, so an issue whose pull requests all say so stays open after the last one merges. Keep it in its `LEDGER.md` row until then, and when it does, close the issue yourself, with a comment naming its pull requests and how it was proved.

## Stacks

GitHub's stacked pull requests work here with the merge queue and the review gate, which judges each pull request in a stack at its head and a queued one on every pull request down to `main` ([ADR 0014](../../../docs/architecture/adr/0014-merge-queue-and-review-gate.md)). Use a stack wherever pull requests build on each other's unmerged work, so Martin need not merge one before the next can start; never to tie independent work together, since a failing entry in the queue takes those above it out too.

- **Making one.** Each branch is made from the one below (`worktree.sh <key> <branch> origin/<branch below>`), and each pull request is opened into the branch below (`gh pr create --base <branch below>`). Once two or more are open, `gh stack link <bottom> … <top>`, with their numbers, bottom first, links them as a GitHub stack, and `gh stack link <stack> <pr>` adds one to the top of a stack already linked. Each description names the pull request below it, so the dependency still reads after GitHub retargets one to `main`; the summary gives the stack's number. `gh stack` is a `gh` extension: `gh extension install github/gh-stack` if `gh stack` is missing.
- **Keeping it current.** When a lower branch changes, or `main` conflicts with the bottom, merge upwards, bottom first: `origin/main` into the bottom branch if it conflicts, then each branch into the one above, and push each. Each branch is its own worker's, so send them one at a time, bottom first, each briefed with what changed below. Merges, never rebases or force-pushes, so review threads keep their lines; `gh stack sync` and `gh stack rebase` rebase and force-push, so neither is used here. If a lower pull request merges on its own, GitHub retargets the next one to `main`, whose diff then shows the merged change again until `origin/main` is merged into it: send its worker to do that, and the ones above take it in turn.
- **Answering review.** A stack's pull requests open together and are answered as one. Answering Copilot on the bottom one, pushing, and setting every branch above rebuilding, then doing the same for the next, costs CI and the merge queue's time for nothing. Instead:
  1. Send each worker, bottom first, to open its pull request and stop ([`worker.md`](worker.md#stacks)), and the next as soon as the one below is pushed and open, without waiting on its CI.
  2. Wait until Copilot has reviewed every one of them (`copilot.sh <pr> <key>` for each), or its hour is over. Gather every finding across the stack, from the threads, the summaries and any check the change failed, and decide the branch each belongs to: a finding on one pull request can be about a change made below it.
  3. Send each worker, bottom first, with the findings that belong to its branch and the threads on its pull request that a branch below fixed (with the commit), to answer them, fix the rest, merge the branch below into its own and push once. That is one pass up the stack, by merges. Nobody waits on CI again after it.

  After that, a branch moves only when it conflicts with `main`, as [Each work item](#each-work-item-one-at-a-time) says.
- **Merging it** is Martin's: the whole stack at once, `gh stack merge <stack> --squash`, which queues an entry for each pull request, each built on the entry below. If an entry fails (a flake, say), it and those above it leave the queue, and he queues them again. Tell him the stack's number.
- **In both repositories.** The app's repository runs the same review gate, so its pull requests stack the same way. A stack never spans the two: a pull request that needs one in the other repository merged first is ordered in the summary, as above.

## Finishing the work, not filing it

The run exists to close work, not to find more. Hold to this order when a sub-agent says the work is bigger than its item, or reports something it found on the way:

1. **The same pull request**, when it is part of doing the item properly: a doc or test that must change with it, a file CODEOWNERS gives Martin, a stale comment it touches. Send a sub-agent back to finish it.
2. **A second pull request on the same item** (`<key>-2`, `Part of #<n>`), when the item is right but too big or too mixed for one review. A worker opens it itself; if one reports it as a `split` instead, queue it next.
3. **A new issue**, only for a different problem: one the item does not need solved to be done, such as a fault that predates it. File it to the standard in `.claude/skills/issue/SKILL.md`, on the milestone it waits for, then add it to the end of this run's list and implement it like the rest.

   A work item Martin named may lead to one new issue at most, and an issue the run filed leads to none: so a run never grows past twice what Martin asked for. Anything more goes in the summary, for Martin to file or drop.

Something that needs Martin's decision, or that cannot merge until something else is deployed, is not an issue to file: it goes in the summary. Never leave an issue that the run filed without its pull request or a reason it was skipped.

## Work a worker cannot do

A worker skips what needs an image pinned first, a migration with an ordered rollout, or the local cluster to prove it. When the plan or the brief names such work, it is yours, not a skip to report:

- **A `deploy/` change that waits for an image** (a new Deployment, a migration, a new setting): list it in the summary with what it waits for, and make it in a later run, once Martin has merged the change that builds the image and the App's deploy pull request that pins it. Only the App's deploy watch opens a pin's pull request (ADR 0005); never open one yourself.
- **A proof or a drill on the local cluster:** run it yourself with the `try-the-line` skill, time-boxed, on the built branches' images before the pull requests open ([Try before review](#try-before-review)), and log what it showed in `NOTES.md`; until then it is in the summary. A proof that needs the deployed version (a real release of the app, an admission policy as `main` sets it) is run after the deploy instead, and says why.
- **Trying it with Martin:** reviews pass faults that a few minutes at the console find. What the try before review needs of him is one sitting, batched, as that section says. Once the work runs on the cluster (its pin or its deploy change synced, and the application healthy, so the old version or half a canary is not what he tries), what needs a person is his to try, as soon as it runs there, not all of it at the end. Give Martin a short list of what to try and what to look for, a few at a time, and turn what he finds into work items of this run: a fault in the item goes back to it, and anything else is held to "Finishing the work, not filing it".

When a milestone's plan asks for `/security-review` on a task, say so in its brief.

A pull request of your own (a deploy change, a fix to a check you ran) gets everything a worker's does: both reviews where a worker's would, `/visual-pr`, Copilot's threads and summary, and `verify.sh`. Brief a worker for it when you can; small is no reason to skip a step.

## After the last work item

With more than one pull request:

1. **Meta-review.** In a fresh sub-agent, read all the open pull requests together against `docs/REVIEWERS.md` (the app's, for one in its repository), for changes that conflict, duplicate each other, pull in different directions (naming, an API's shape, how a doc describes something), or would leave `main` broken in any order of merging. It fixes what it finds on the pull request where it belongs. Wait for it to end, and verify every pull request again.
2. **Checks.** Every pull request's checks pass, no thread is unresolved except the arguable ones and other reviewers' own, and Copilot's review summary has its answer.

Then write `<run dir>/SUMMARY.md` and give it to Martin, leaving out what does not apply:

- each work item: its pull requests, or why it was skipped, a line each; mark the issues this run filed, and list what it found but left unfiled;
- the order to merge in, and why, with any update a merge will force on another;
- the files CODEOWNERS gives Martin that each pull request changes, and why, in a line each;
- the decisions made on Martin's behalf, and the open threads to look at;
- anything left after a merge (a deploy pull request, an image pin) and anything that waits on Martin's decision.

Done means every work item, and every issue the run filed, has open pull requests with passing checks, verified, or a written reason for skipping it.
