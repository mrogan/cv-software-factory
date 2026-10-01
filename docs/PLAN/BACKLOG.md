# Backlog

Follow-ups and ideas that have no milestone yet, or need more thought before they get one. It is a holding place, not a plan: when a milestone starts, take what fits into its file and delete it here; when one ends, add what it left open.

Decisions that need Martin go in [`OPEN-QUESTIONS.md`](../OPEN-QUESTIONS.md) instead. Things that are simply true go in the spec, `COMPONENTS.md` or `AGENTS.md`.

| Item | Why it matters | Likely home |
|---|---|---|
| Updates for what Dependabot can't see | `mise.toml`, the chart versions in the Argo CD Applications, the Argo CD chart in the `Makefile` and the k3s image are pinned by hand and will drift. Renovate covers all of them; a scheduled check is the smaller option. | Before milestone 6 |
| Try a `deploy/` change before it merges | Argo CD deploys `main`, so a manifest change is first exercised after merge. Letting `make up` point the root Application at a branch would close that gap. | Milestone 2 |
| Port the station without inline styles | The console's content security policy allows no inline styles, and `station.js` uses a `<style>` element and `style` attributes. The port needs constructable stylesheets and SVG presentation attributes, or the policy weakens. | Milestone 3 |
| Tempo answers a minute or two late | A new trace is not queryable straight away in Tempo 3. Verify and the replay's captured artifacts must wait for it, or rely on metrics and logs for anything immediate. | Milestones 4 and 6 |
| The factory keeps its own pull requests up to date | `main` requires branches to be current, so what merges is what was tested. Each merge leaves other open pull requests needing "Update branch": a click for Martin, and for the factory's GitHub App a call it must make itself. GitHub's merge queue would do it, but only organisation-owned repositories get one, and these stay on Martin's account. | Milestone 5 |
| Scorecard's Branch-Protection rises with reviews | It scores 4 of 10 because `main` requires no approver, code-owner review or last-push approval. None can be required while every pull request is Martin's; they switch on with code-owner review. | Milestone 5 |
