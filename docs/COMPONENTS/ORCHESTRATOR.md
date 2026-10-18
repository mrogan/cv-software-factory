# Orchestrator

Work queue, state, retries, concurrency and stopping the line. Part of the [factory plane](README.md#factory-plane).

- **v1:** Postgres-backed queues and TypeScript workers: the inbox, and the line.
- **Later:** Temporal, AWS Step Functions.

After the merge, the line carries a work item through [Release and Verify](RELEASE-AND-VERIFY.md), which has a page of its own. The agents it runs are [the planner](PLANNER.md), [the coder](CODER.md), [the reviewer](REVIEWER.md) and [the describer](DESCRIBER.md).

## The inbox

Senses insert signals, and the line inserts the planner's findings. Each finding carries an id from its work item and what it says, so neither a step tried again nor a later plan leaves one twice.

[Triage](TRIAGE.md) takes each signal once, with `for update skip locked` under a lease, woken by `NOTIFY`, with a limit on attempts.

## The line

`apps/factory/src/line`, run by `factory line serve`. `LINE_MODE` sets what it does:

| `LINE_MODE` | The line |
|---|---|
| `off` (the default) | Takes no work |
| `live` | Acts in GitHub through the [GitHub worker](GITHUB-WORKER.md) |
| `dry-run` | Has the GitHub worker record what it would do ([dry run](GITHUB-WORKER.md#dry-run)) |

The `line` table holds the work items on the line, by stage and under a lease.

```mermaid
flowchart LR
  ticket([Open ticket]) --> plan[Plan]
  plan -- spec --> build[Build]
  plan -- spec overlaps work in flight --> waits[Waits]
  waits -- its signal still there --> build
  waits -- its signal gone --> closed
  build -- push --> gates[Gates]
  gates -- fail --> build
  gates -- pass --> review[Review]
  review -- blocking findings --> build
  review -- approved with suggestions, once --> build
  review -- approved, described --> merge{{Merge}}
  merge --> release[Release]
  release -- promoted --> verify[Verify]
  verify -- cleared --> closed([Closed as verified])
  verify -- persists, once --> plan
```

Each stage can also hold for Martin (see [Holds](#holds-and-martins-answers)).

### Taking work

- It takes the oldest open ticket of the highest severity into Plan when nothing is in Plan or waiting for Build. A work item that waits for overlapping work (below) is at a stage of its own, `waiting`, so the line still takes the next ticket.
- It runs one step at a time in each of Plan, Build and Review.
- It runs one step at a time on the local model, whatever its stage, since LM Studio answers one prediction at a time. A step whose agent `policy/models.ts` sends there (every agent, under `ALL_LOCAL`) waits while another such step runs, and the line tries again on its next pass. A step on Claude never waits for one on the local model, so a mixed profile keeps its pace.
- As a ticket enters Plan, it opens the ticket's issue through the App, from the ticket's public view. The fix's pull request refers to that issue.
- After Martin's merge, it carries the work item through Release and Verify until it closes.

Two settings narrow what it takes:

- **`LINE_ONLY`**, set to a work item, makes the line act on that one alone.
  - It takes that ticket onto the line whatever else is in Plan or Build.
  - It starts no step for any other work item, reads nothing for it and appends nothing.
  - It says nothing of the deploy pull request.
  - It still watches the app's releases, and records one that carries that work item or none (those go on the line). A release that also carries another work item is left for the whole line. The work item stays held at Release (cause `deploy`, so Needs you lists it) until the line records that release, or finds it live.
- **`LINE_TAKE`**, set to a number, has the line take tickets by its own rule until it has taken that many work items in all. The count comes from the `line` table, so a restart takes none more. It then takes no more, and carries those it has to their end.

### A spec that overlaps

Two tickets can be one defect, seen by two checks on two pages, and that shows only once the planner names the files. So after Plan, before the coder starts and before a spec that always needs Martin is held for him, the line compares the spec's scope with the latest spec of each other work item in flight: on the line, not ended or closed, in any pass, held or merged too. Every shared file counts, tests included (`scopesOverlap` in the events package, which matches scope entries as the scope fence does).

- **A spec that shares a file waits** (`wait.started`, naming the work items and the files), at stage `waiting`. A wait is not a hold: it needs nobody, and Needs you does not list it.
- **When each work item it waits on is verified or closed**, the sense that saw its defect looks again ([Verify](RELEASE-AND-VERIFY.md#held-and-waiting-work-items)). Cleared, it closes as verified. Still there, or the sense cannot tell, it goes on to Build with its spec as written: the coder starts from the current `main`, and the gates and review judge the result.
- **While it waits**, each release is looked at as for a hold, and one that clears its signal closes it.
- **No cycles.** A work item never waits on one that waits on it, directly or through others.
- A spec written again before any push is checked again; one written once there is a pull request is not.
- **With `LINE_ONLY`** there is no wait: a line of one work item sees nothing else.

### A ticket that reopens

When a verified ticket reopens ([triage](TRIAGE.md) reopens it), its work item comes back into Plan for a fresh pass, whatever else is on the line and whatever `LINE_TAKE` says, since the line took it already. Each pass of the line, before it takes a ticket:

1. It waits until the runners' old volume is gone.
2. It reopens the ticket's issue through the App, saying what came back. If the App can no longer open that issue, the work item comes back without it and the line opens a new one.
3. It moves the work item to Plan, forgetting its last pass's failures, pending effects and coder's session.

### After a dry run

A dry run works on real tickets, so a line that starts `live` on the same store finds what the dry run left. It could not carry on from it: GitHub never had the dry run's pull requests, merges or issues, and a dry run's fix never shipped. As it starts, before anything else, it ends each (`dryRunLeft` in `line/machine.ts`):

- **A work item whose pull request or issue was the dry run's**, the pull request merged or not, closes with no change, saying so. Its issue closes too, as not planned, when GitHub has it. The next signal of its defect opens a fresh ticket.
- **A ticket the dry run verified** still has its defect, and reopens (`work-item.reopened`, with `dryRun: true` and the line as its actor). It comes back into Plan as any reopened ticket does, with a new issue, since its own was the dry run's. The planner is told of no fix that came back: none shipped.

What it cannot end on one pass, because GitHub or the store failed, it tries again on the next, and until then it reads no gates and starts nothing for that work item. A reopened work item waiting to come back into Plan is left to that, which forgets a dry run's issue. With `LINE_ONLY`, it ends only that work item's.

## Steps

- **State is derived.** What a work item does next is a pure function of its events (`line/machine.ts`), so after a stop or a crash the line carries on from the last event.
- **One module per agent.** Each agent's module (`line/agents/`) says what its step is given, its prompt and schema, and what its result does in GitHub and as events. The worker runs them all one way.
- **Runners.** Each step runs in an [agent runner](AGENT-RUNNERS.md).
- **Turns and deadlines** are set for Claude. When `policy/models.ts` sends an agent's calls to the local model (the profile's, under `ALL_LOCAL`, which the line reads as the [gateway](LLM-GATEWAY.md) does), its step has twice the turns and four times as long.
- **Model calls.** Each step's calls become one `model.called`, summed from `model_calls` by the step's job, with the turns it was given. It counts only the calls a model answered, a cassette replayed, or that failed part way with tokens to show for it; none the gateway or the provider refused.

### When a step fails

```mermaid
flowchart TD
  step[Step runs in a runner] --> handback{Handback}
  handback -- "nothing, out of turns, failing,<br>or refused by the agent's schema" --> second{Second failure?}
  second -- no --> step
  second -- yes --> held[Holds for Martin: failures]
  handback -- result --> effects[Effects in GitHub and the store]
  effects -- GitHub or the store fails --> sixth{Sixth try?}
  sixth -- "no: later, without the agent" --> effects
  sixth -- yes --> held
  effects -- done --> next[Next step]
```

- **A failed step** (one that hands back nothing, ends out of turns or failing, or hands back a result its agent's schema refuses) runs again as a new job. After two failures the work item holds.
- **A failed effect is not the step's failure.** When GitHub or the store fails while a result is acted on, the handback is kept in the `line` table and its effects are tried again later without the agent. Each write in GitHub is recorded as it is begun and done, so none is done twice. After six tries the work item holds.
- **A coder that changes nothing and says why** has not failed:
  - after the gates or a review sent the work back, the work item holds where it came from, under that cause (`gates` or `review`), with the coder's reason;
  - a first round that finds nothing to fix holds as `nothing-to-fix`.
- **A patch the scope fence refuses** is recorded as `action.refused` (`scope-fence`, with the fence's output and its verdict on each file). It goes back to the coder once, which resumes its session from a fresh checkout. The second refusal holds the work item.

## Build, gates and review

- **The pull request.** The coder's first push opens the fix's pull request as a draft, with the ticket's issue and the spec. It is readied only once the [describer](DESCRIBER.md) has written its description. Work sent back to Build after that (a gate that fails on a newer commit, or Martin's words on the hold for his merge) puts it back to draft first, so GitHub will not merge a round nobody has reviewed, and the describer writes up the next round again before Martin is asked.
- **Each push** records its own files and the pull request's whole change, as GitHub compares its head with main.
- **Reading GitHub.** Once a minute the line reads its pull requests' check runs and merges through the GitHub worker, and appends `gates.started`, `gate.finished`, `gates.finished` and `pull-request.merged`. It leaves out the factory's own check runs. A merge comes after what the gates on the pull request's head did since the last read, so a merge soon after they pass still finishes their round; at a merge, the round ends with it, judged on the checks that have finished. Once gates have passed on a push, a run on a newer commit of it (GitHub bringing the branch up to date with main) leaves the work item where it waits while it runs, and replaces them when it ends: if it passes, nothing moves; if it fails, the work goes back to the coder as a failure on the push's first run would, and a wait for Martin's merge, which GitHub would refuse, ends.
- **Failing gates** send the work back to the coder twice.
- **A review's blocking findings** go back to the coder's session, with its suggestions, and a fresh reviewer is told them in the next round. What still blocks after two reviews holds, as does a review the reviewer escalates.
- **An approval's suggestions** go back to the coder once in a pass, before the describer writes the change up, so that every review thread is answered before Martin's merge. The coder takes each or declines it with a reason (`suggestions.answered`). If it takes any, the gates and a fresh reviewer run again, and that review goes on whatever it suggests: suggestions alone never send the work round twice. It counts toward the two reviews like any other, and is at least the second, so if it blocks it holds for Martin. If it declines them all, it changes nothing and the approval stands. Martin's approval of a held review sends the change on with no such round.
- **An out-of-scope spec.** Every spec tagged `out-of-scope` that the planner wrote under the rule (its criteria name where each comes from), a rewritten one too, holds at Plan for Martin's approval before the coder starts, in every autonomy mode ([approval routing](APPROVAL-ROUTING.md)).
- **A spec written again** once there is a pull request sends the work back to the coder, held to the new spec, and sets aside the review of the old one, so the change is reviewed again.
- **The end of a pull request.**
  - A pull request closed unmerged closes its work item: as verified while a look again that cleared stands on its hold (below), and with no change otherwise.
  - A work item whose pull request merges, or that closes, has its runners' volume deleted, since a later pass starts afresh from main.

## Holds and Martin's answers

Each hold names its cause, and Martin's answer does what `ANSWERS` in `line/machine.ts` says for that cause. Rejecting always closes the work item and its issue.

| Cause | Held when | Approving | Answering |
|---|---|---|---|
| `question` | The planner asks what only Martin can say | Carries on | Carries on; his answer reaches every later plan |
| `ticket-rejected` | The planner rejects the ticket | Agrees, and closes the work item | Carries on; his answer reaches every later plan |
| `spec` | A spec is tagged `out-of-scope` | Carries on to Build | Sends it back to the planner |
| `scope` | The scope fence refused the coder's patch twice | Sends it back to the planner, told the coder needed those files | Sends it back to the planner with what the fence printed |
| `nothing-to-fix` | The coder's first round finds nothing to fix | Agrees, and closes the work item | Sends it back to the planner with the coder's reason |
| `failures` | A step failed twice, or its effects failed six times | Runs the step again | Runs the step again, with his words |
| `gates` | Gates failed after two returns, or the coder changed nothing after gates | Sends the work back to the coder | Sends the work back to the coder, with his words |
| `review` | Still blocking after two reviews, or after the round for an approval's suggestions, an escalation whose findings do not cite the ticket, or the coder changed nothing after a review | Stands in for the reviewer's approval | Sends the work back to the coder, with his words |
| `beyond-ticket` | The reviewer escalates a spec that goes beyond its ticket | Stands in for the reviewer's approval | Sends the spec back to the planner |
| `merge` | The fix has passed its gates and review | Waits for his merge | Sends the work back to the coder |
| `deploy` | The merged fix waits for a release ([Release](RELEASE-AND-VERIFY.md#release)) | Waits: he settles it by merging the deploy pull request | Waits |
| `verify` | The signal persisted a second time, Verify could not tell for 24 hours, or nothing can judge the fix ([Verify](RELEASE-AND-VERIFY.md#verify)) | Closes the work item as verified, with his words | Sends it back to Plan |
| `spend` | The work item has spent its cap on models | Carries on, and holds again until the cap is raised | Carries on |

### A held work item whose defect went another way

A held work item's defect can go with another change: a duplicate's fix, Martin's own commit, a dependency update. After each real release is promoted, and once as a hold starts, the sense that saw it looks again at the version the stable Service runs ([Verify](RELEASE-AND-VERIFY.md#held-and-waiting-work-items)). What a look that cleared does depends on the cause (`closesWhenCleared` in `line/machine.ts`):

- **The line's own holds close as verified**: `scope`, `gates`, `failures`, `spend`, and `review` when the reviewer asked for changes once too often. The line closes the issue as completed and the pull request unmerged, each saying which release cleared it.
- **Holds that wait on Martin's judgement stay**: `spec`, `question`, `ticket-rejected`, `beyond-ticket`, `nothing-to-fix`, `merge`, `deploy`, `verify`, `tests-first`, `unknown`, and `review` when the reviewer escalated. The look is recorded, and the hold says the signal cleared on that version. While it stands, his closing the work item's pull request in GitHub closes it as verified.

A signal seen since on that version or a later one, or a later look that finds it, ends the clearance. Triage's holds are never looked at: they come before a ticket reaches the line.

Triage's own holds, `finding`, `suggestion`, `burst` and `environment`, are on [its page](TRIAGE.md). An answer in words to one of them settles nothing, so the hold stands and Needs you still lists it (`WORDS_LEAVE_HELD` in the events package, which the line and the console both read).

## Spend

- **A work item's cap.** Each work item has a cap on models (the gateway's, from the same `FACTORY_PROFILE`). A work item that has spent it holds before its next step, with the cap on the hold.
- **The gateway's caps.** A cap the gateway has set and not cleared (`spend.capped`: the factory's own day or month cap, or the provider an agent's calls go to refusing) starts no step for that agent, since every call would be refused.
  - A step that hands back an error while such a cap is set, or after one was set while it ran, counts for nothing and runs again once the cap clears.
  - The `spend.cleared` that clears it wakes the line (`line/caps.ts`).

## Stopping the line

Every worker checks for `line.stopped` before it takes work. `make stop-the-line` appends it, and then the line:

- deletes the Jobs of every step in hand at once, starts none still preparing, and records nothing of them;
- runs them afresh when the line starts;
- aborts a release of the app in flight ([progressive delivery](PROGRESSIVE-DELIVERY.md)), which the release watch records as `release.aborted` by `stop` ([release and verify](RELEASE-AND-VERIFY.md#its-events)).

A stopped line still watches the app's releases: it records whatever they do (a start, a step, a promotion, a rollback, an analysis error, an abort) and sends a rollback's signals to the inbox, where they wait. It moves no work item, and a dry run's releases wait for it to start.

## The soak check

`factory line soak-check` reads the store and the cluster the morning after a soak (`line/soak.ts`), and reports:

- leases held past their expiry;
- runners' Jobs and volumes left for ended work items, and volumes left for merged ones;
- events that are not valid once upcast;
- the spend: each work item's within the profile's cap on one, or nothing at all with `--no-spend`, for a night on the local model;
- the work items taken, by how each ended, with their minutes in each stage.
