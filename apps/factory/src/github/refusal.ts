/**
 * Proves the App cannot change a workflow (guardrail 1: agents cannot change the rules). It tries, the way the
 * factory commits anything, and keeps what GitHub said: milestone 9's red-team harness shows the refusal.
 *
 * On a branch of its own, made from main and deleted afterwards, it first commits an ordinary file, which GitHub must
 * accept: the control, without which a refusal would show only that the App could not commit at all. Then it asks
 * for a signed commit that adds a workflow. The App has no `workflows` permission, so GitHub must refuse. If GitHub
 * accepts it, that is the finding: the branch is deleted all the same, and the result says so.
 */
import type { LiveActions } from './actions.ts';
import { type GitHub, GitHubError } from './client.ts';

export const REFUSAL_BRANCH = 'factory/workflow-refusal';
export const WORKFLOW = '.github/workflows/factory-refusal.yml';
export const CONTROL = 'factory-refusal-control.txt';

export interface Refusal {
  repo: string;
  at: string;
  attempted: string;
  /** The control: the ordinary commit just before, which GitHub accepted. */
  control: { path: string; commit: string };
  /** What GitHub answered: refused, as it must be, or accepted. */
  outcome: 'refused' | 'accepted';
  kind?: GitHubError['kind'];
  status?: number;
  message?: string;
}

const WORKFLOW_TEXT = `# Never merged: the factory's App tries to add this, and GitHub must refuse it.
name: refusal
on: workflow_dispatch
permissions: {}
jobs:
  never:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "this workflow was never meant to exist"
`;

export async function tryWorkflowWrite(
  github: GitHub,
  actions: LiveActions,
  repo: string,
  now = () => new Date(),
): Promise<Refusal> {
  const main = await github.request<{ object: { sha: string } }>(repo, 'GET', `/repos/${repo}/git/ref/heads/main`);
  await actions.setBranch(repo, REFUSAL_BRANCH, main.object.sha, { force: true });
  const attempted = `a signed commit (createCommitOnBranch) adding ${WORKFLOW} on ${REFUSAL_BRANCH}`;
  const encode = (text: string) => new TextEncoder().encode(text);
  try {
    // If this throws, the App cannot commit at all, and the proof has nothing to show: it fails rather than records.
    const controlCommit = await actions.commit(repo, {
      branch: REFUSAL_BRANCH,
      expectedHead: main.object.sha,
      message: 'chore: an ordinary commit the factory may make',
      changes: { additions: [{ path: CONTROL, contents: encode('The App may commit this.\n') }], deletions: [] },
    });
    const control = { path: CONTROL, commit: controlCommit };
    return await attempt(control);
  } finally {
    await actions.deleteBranch(repo, REFUSAL_BRANCH);
  }

  async function attempt(control: Refusal['control']): Promise<Refusal> {
    try {
      await actions.commit(repo, {
        branch: REFUSAL_BRANCH,
        expectedHead: control.commit,
        message: 'ci: a workflow the factory must not be able to add',
        changes: { additions: [{ path: WORKFLOW, contents: encode(WORKFLOW_TEXT) }], deletions: [] },
      });
      return { repo, at: now().toISOString(), attempted, control, outcome: 'accepted' };
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      return {
        repo,
        at: now().toISOString(),
        attempted,
        control,
        outcome: 'refused',
        kind: error.kind,
        ...(error.status === undefined ? {} : { status: error.status }),
        message: error.message,
      };
    }
  }
}
