# Backlog

Follow-ups and ideas that have no milestone yet, or need more thought before they get one. It is a holding place, not a plan: when a milestone starts, take what fits into its file and delete it here; when one ends, add what it left open.

Decisions that need Martin go in [`OPEN-QUESTIONS.md`](../OPEN-QUESTIONS.md) instead. Things that are simply true go in the spec, `COMPONENTS.md` or `AGENTS.md`.

| Item | Why it matters | Likely home |
|---|---|---|
| Updates for what Dependabot can't see | `mise.toml`, the chart versions in the Argo CD Applications, the Argo CD chart in the `Makefile` and the k3s image are pinned by hand and will drift. Renovate covers all of them; a scheduled check is the smaller option. | Before milestone 6 |
| The seeded baseline and improvements | Reset restores the tree the private repository published. Once the factory ships an improvement to the app, that tree is out of date, and a reset would undo the improvement. Either the baseline moves with each improvement or reset re-applies the patches to the current app. | Milestone 8 |
| The app's repository can claim any ingress host | Its Argo CD project allows an Ingress in the `website` namespace, and an Ingress names its own host: a change there could claim `console.localhost` and take the console's traffic. Admission control should allow it only the app's own host. | Milestone 6, with Kyverno |
| Dependabot's npm updates fail in the app's repository | The first run stopped while processing `lefthook`, inside pnpm's check of the lockfile against the supply-chain policy. The other ecosystems ran. Not yet diagnosed, and not yet checked here. | Before milestone 5 |
| The correct app goes stale | The private repository keeps the app as first written; the public one moves on. A patch written against the old app may not apply to the new one, and the private CI only proves it against the old. The injector needs patches that apply to the app as it stands. | Milestone 9 |
| Two versions side by side | Every signal carries the version and the dashboard splits by it, but nothing has yet run two versions at once to show it. | Milestone 6 |
| Tempo answers a minute or two late | A new trace is not queryable straight away in Tempo 3. Verify and the replay's captured artifacts must wait for it, or rely on metrics and logs for anything immediate. | Milestones 4 and 6 |
| The factory keeps its own pull requests up to date | `main` requires branches to be current, so what merges is what was tested. Each merge leaves other open pull requests needing "Update branch": a click for Martin, and for the factory's GitHub App a call it must make itself. GitHub's merge queue would do it, but only organisation-owned repositories get one, and these stay on Martin's account. | Milestone 5 |
| Scorecard's Branch-Protection rises with reviews | It scores 4 of 10 because `main` requires no approver, code-owner review or last-push approval. None can be required while every pull request is Martin's; they switch on with code-owner review. | Milestone 5 |
| The story of a finished work item | `work-item.summarised` holds the paragraph at the top of a sheet. Triage writes it from a template over typed fields, which suits an item that has just opened. An item that has been through the line deserves its story told: by an agent from the item's events, within its budget, or by the closing step. | Milestone 5 |
| The console reads every event | The page fetches the whole history on load: 430 sample events are about 25 KB gzipped, well inside the speed budget. A real factory will outgrow that; then the server sends a snapshot of the projection and the events since, or pages the reel. | When the event count passes about 5,000 |
