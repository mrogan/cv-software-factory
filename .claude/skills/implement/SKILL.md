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

1. **Key each work item.** An issue's key is its number. Something from the conversation is a brief, and its key is a short slug (`station-order`). An issue's second pull request is `<n>-2`.
2. **Make the run directory**: `run.sh <key>...` makes `scratch/implement/<date>-<keys>/` and prints its path. Notes, briefs, PR notes and the summary go there. A run that spans sessions (a milestone's part, with Martin merging between them) keeps three files there as well, which each session reads first and updates last, so that nothing lives only in a reply. A later session takes up the same run directory, named in its handover, rather than making a new one:
   - `LEDGER.md`: a row per work item, with its state, pull requests, what it waits on, and the next action;
   - `MARTIN.md`: what waits on Martin, in the order to do it, each pull request with what to look at, the files CODEOWNERS gives him, the decisions made for him, the update a merge forces on another pull request, and what to try once it is deployed;
   - `FOLLOWUPS.md`: each loose end the moment it is found (a `found`, a workflow problem, something only Martin can do), with where it goes, emptied at the end of each work item.
3. **Write each brief from the conversation** to `<run dir>/brief-<slug>.md`. The sub-agent sees nothing of this conversation, so the brief stands alone:
   - **Goal**: the change, and why, in a paragraph;
   - **Agreed**: every decision Martin made or accepted, in Martin's terms, and every option turned down;
   - **Scope**: the files, components and docs named, and what is explicitly out;
   - **Open**: anything left undecided, which the sub-agent settles and reports;
   - **Related**: issues, pull requests and commits named.

   Write down what was said, not what you would add. If the conversation left open a decision that changes what gets built, ask Martin now, in one question, while he is here.
4. **Read every issue** far enough to brief it. Note work items that touch the same files or depend on each other, and order them so that one another builds on goes first. Each pull request branches from `origin/main`. When several work items need the same piece (a component, a helper they all reuse), make that piece a small work item of its own, branched from `origin/main` and done first, rather than stacking one item's pull requests on another's. Martin can merge a small piece quickly. Don't wait for him: until it merges, each item that uses it stacks on it alone, not on one another; once it has, they branch from `main`. Stack only what truly cannot be done without another's unmerged work, and say so, with the order to merge in.

## Each work item, one at a time

1. **Brief** a fresh sub-agent to follow `${CLAUDE_SKILL_DIR}/worker.md`, with the key, the issue or the brief's path, the run directory, the scripts' path, and what you know about overlaps with the other work items and their pull requests.
2. **Wait for it to end, not only to report.** A sub-agent can hand back its report while its own background work is still running, and resume afterwards. Go on only when its task notification says it finished with nothing of its own still running, and `ListAgents` shows neither it nor anything it started still running; `TaskStop` any that is. A reviewer a worker started may send its findings to you by mistake: forward them, with SendMessage, to the worker that owns the pull request.
3. **Verify** before you log or say anything: `verify.sh <key> <pr>` for each pull request, or `verify.sh <key>` for a skip. If the report and the script disagree, the script wins: log what is true, and say so. A pull request is not ready while Copilot may still review, and `verify.sh` says so.
4. **Settle what it handed back.** A `split` or a `found` is yours to decide, not the sub-agent's (see below).
5. **Log** the verified outcome and your decisions in `<run dir>/NOTES.md`.
6. **Retry or move on.** A sub-agent that failed, stopped partway or reported something untrue is stopped before anything else touches its worktree. A new sub-agent may take the worktree over, briefed with what is actually there; otherwise note it and go on.

Never run two sub-agents at once, and never give a worktree to a second agent while the first can still run.

When Martin merges one pull request, bring up to date only what that merge forces: a pull request that now conflicts with `main`, and in a stack each one built directly on the one that merged. Send a sub-agent to fetch and merge `origin/main` into it and resolve, briefed with what merged: it owns the worktree for that, as the first did. Where the merge conflicts on the merged pull request's own changes, it starts from `main`'s side, which carries that pull request as reviewed, and carries its own pull request's changes over onto it. Once its checks pass and `verify.sh` passes again, tell Martin it is ready to merge.

A pull request marked `Part of #<n>` closes nothing, so an issue split across several stays open after the last one merges. When it does, close the issue yourself, with a comment naming its pull requests and how it was proved.

In a stack, Martin merges each pull request the moment it is green, and each merge squashes the branch the next one is built on. Leave the ones further up until their turn: a whole stack brought up to date at once has to be done again after every merge.

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
- **A proof or a drill on the local cluster:** run it yourself with the `try-the-line` skill, time-boxed, and log what it showed in `NOTES.md`; until then it is in the summary.
- **Trying it with Martin:** reviews pass faults that a few minutes at the console find, so try each work item as soon as its pin is synced on the local cluster, not all of them at the end. Give Martin a short list of what to try and what to look for, a few at a time, each with a compact progress line (`#575: 2 of 4 tried, 1 fault`), and turn what he finds into work items of this run.

When a milestone's plan asks for `/security-review` on a task, say so in its brief.

A pull request of your own (a deploy change, a fix to a check you ran) gets everything a worker's does: both reviews where a worker's would, `/visual-pr`, Copilot's threads and summary, and `verify.sh`. Brief a worker for it when you can; small is no reason to skip a step.

## After the last work item

With more than one pull request:

1. **Meta-review.** In a fresh sub-agent, read all the open pull requests together against `docs/REVIEWERS.md`, for changes that conflict, duplicate each other, pull in different directions (naming, an API's shape, how a doc describes something), or would leave `main` broken in any order of merging. It fixes what it finds on the pull request where it belongs. Wait for it to end, and verify every pull request again.
2. **Checks.** Every pull request's checks pass, no thread is unresolved except the arguable ones and other reviewers' own, and Copilot's review summary has its answer.

Then write `<run dir>/SUMMARY.md` and give it to Martin, leaving out what does not apply:

- each work item: its pull requests, or why it was skipped, a line each; mark the issues this run filed, and list what it found but left unfiled;
- the order to merge in, and why, with any update a merge will force on another;
- the files CODEOWNERS gives Martin that each pull request changes, and why, in a line each;
- the decisions made on Martin's behalf, and the open threads to look at;
- anything left after a merge (a deploy pull request, an image pin) and anything that waits on Martin's decision.

Done means every work item, and every issue the run filed, has open pull requests with passing checks, verified, or a written reason for skipping it.
