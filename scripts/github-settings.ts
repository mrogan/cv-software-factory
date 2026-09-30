/**
 * Applies the repository's GitHub settings, so they are reviewable like code and reproducible. Safe to run again.
 *
 *     node scripts/github-settings.ts [owner/repo]    # default mrogan/cv-software-factory
 *
 * Needs the GitHub CLI, signed in as an admin of the repository.
 */
import { execFileSync } from 'node:child_process';

const repo = process.argv[2] ?? 'mrogan/cv-software-factory';

/** GitHub Actions, as the app that reports check runs. */
const GITHUB_ACTIONS = 15368;

/** The jobs that must pass before anything merges into main. */
const REQUIRED_CHECKS = ['lint, types, tests', 'image builds', 'pull request title'];

const RULESET = {
  name: 'main',
  target: 'branch',
  enforcement: 'active',
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  // Nobody bypasses it, including the owner.
  bypass_actors: [],
  rules: [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    { type: 'required_linear_history' },
    { type: 'required_signatures' },
    {
      type: 'pull_request',
      parameters: {
        // Code-owner review is switched on in milestone 5, when the factory opens pull requests and Martin
        // reviews them. Until then every pull request is Martin's, and GitHub never counts an author's approval.
        required_approving_review_count: 0,
        require_code_owner_review: false,
        dismiss_stale_reviews_on_push: true,
        require_last_push_approval: false,
        required_review_thread_resolution: true,
        allowed_merge_methods: ['squash'],
      },
    },
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: false,
        required_status_checks: REQUIRED_CHECKS.map((context) => ({ context, integration_id: GITHUB_ACTIONS })),
      },
    },
  ],
};

function gh(method: string, path: string, body?: unknown): string {
  const args = ['api', '--method', method, `repos/${repo}${path}`, '-H', 'X-GitHub-Api-Version: 2022-11-28'];
  if (body !== undefined) args.push('--input', '-');
  return execFileSync('gh', args, { input: body === undefined ? '' : JSON.stringify(body), encoding: 'utf-8' });
}

function step(what: string, apply: () => unknown): void {
  apply();
  console.log(`  ✓ ${what}`);
}

console.log(`Applying settings to ${repo}`);

step('squash merges only, titled from the pull request; branches deleted after merge', () =>
  gh('PATCH', '', {
    has_wiki: false,
    has_projects: false,
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    squash_merge_commit_title: 'PR_TITLE',
    squash_merge_commit_message: 'PR_BODY',
    delete_branch_on_merge: true,
    allow_auto_merge: true,
    allow_update_branch: true,
  }),
);

step('secret scanning with push protection', () =>
  gh('PATCH', '', {
    security_and_analysis: {
      secret_scanning: { status: 'enabled' },
      secret_scanning_push_protection: { status: 'enabled' },
    },
  }),
);

step('Dependabot alerts and security updates', () => {
  gh('PUT', '/vulnerability-alerts');
  gh('PUT', '/automated-security-fixes');
});

step('private vulnerability reporting', () => gh('PUT', '/private-vulnerability-reporting'));

step('Actions must be pinned to a full commit SHA', () =>
  gh('PUT', '/actions/permissions', { enabled: true, allowed_actions: 'all', sha_pinning_required: true }),
);

// Workflows start read-only and ask for more per job. They may open pull requests (the deploy and release
// pull requests), which is what "approve" also grants; no review is counted from them.
step('workflow tokens read-only by default; workflows may open pull requests', () =>
  gh('PUT', '/actions/permissions/workflow', {
    default_workflow_permissions: 'read',
    can_approve_pull_request_reviews: true,
  }),
);

step("first-time contributors' workflows wait for approval", () =>
  gh('PUT', '/actions/permissions/fork-pr-contributor-approval', { approval_policy: 'first_time_contributors' }),
);

step(
  `ruleset "${RULESET.name}": pull requests only, ${REQUIRED_CHECKS.length} required checks, linear and signed`,
  () => {
    const existing = JSON.parse(gh('GET', '/rulesets')) as { id: number; name: string }[];
    const id = existing.find((r) => r.name === RULESET.name)?.id;
    if (id) gh('PUT', `/rulesets/${id}`, RULESET);
    else gh('POST', '/rulesets', RULESET);
  },
);
