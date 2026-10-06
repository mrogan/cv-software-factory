# The runner's skills

A Claude Code plugin, `factory`, holding the skills a runner's step can name. The `factory-runner` image carries it read-only, and the agent step loads it only for a step that names one of its skills, and only that skill (`../src/agent.ts`). A runner knows which step it is running, so the step names the skill rather than leaving the model to choose one; nothing in the app's checkout or the job's volume can add a skill.

## visual-pr

The describer's: writes a pull request's description to fit its change.

Vendored from [HumanLayer's skills](https://github.com/humanlayer/skills/tree/4e39d8fe020f17e5810b450e2646a7c4a7aa7a74/plugins/visual-pr/skills/visual-pr) at commit `4e39d8fe020f17e5810b450e2646a7c4a7aa7a74`, under the MIT licence in [`skills/visual-pr/LICENSE`](skills/visual-pr/LICENSE). Changed for the factory:

- It writes the description to the file the step names, and opens, edits and pushes nothing: the line publishes the description through the GitHub worker.
- Its fixed headings are gone, with the template that held them and the final answer's template. A description fits its change: one that needs a line gets a line. A repository's own pull request template is read as the questions a reviewer there expects answered, not headings to fill.
- `references/show-me.md` makes no HTML artifact, which a pull request's description cannot hold.

The commit that vendored it holds the upstream files unchanged, so `git log -p` on this folder shows each change.
