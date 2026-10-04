/**
 * Applies the public repositories' GitHub settings, so they are reviewable like code and reproducible. Both get
 * the same rulesets and security settings; only the checks each requires differ. Safe to run again.
 *
 *     node scripts/github-settings.ts                  # every repository below
 *     node scripts/github-settings.ts <owner/repo>     # one of them
 *
 * Needs the GitHub CLI, signed in as an admin of the repository.
 */
import { execFileSync } from 'node:child_process';

/**
 * Each repository, and the jobs that must pass before anything merges into its main. A job in a shared workflow
 * reports as "<calling job> / <job>".
 */
const REPOSITORIES: Record<string, string[]> = {
  'mrogan/cv-software-factory': ['lint, types, tests', 'browser tests', 'image builds', 'pull request title'],
  'mrogan/cv-worlds-worst-website': ['lint, types, tests', 'image builds', 'title / pull request title'],
};

/** GitHub Actions, as the app that reports check runs. */
const GITHUB_ACTIONS = 15368;

/** Repository roles, as a ruleset's bypass list names them. */
const ADMIN_ROLE = 5;

/**
 * Two rulesets on main (ADR 0009). The first holds everything but review, and nobody bypasses it: every change is a
 * pull request, squash-merged, signed and linear, once its required checks pass.
 */
const rules = (requiredChecks: string[]) => ({
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
        required_status_checks: requiredChecks.map((context) => ({ context, integration_id: GITHUB_ACTIONS })),
      },
    },
  ],
});

/**
 * The second holds review: a code owner's approval, after the last push, on every pull request. Martin is the code
 * owner and the author of every human pull request, and GitHub never counts an author's own approval, so the
 * repository's admin may bypass this one, and only when merging a pull request. The merge records the bypass. The
 * factory's App may not bypass it, so each of its pull requests waits for Martin.
 */
const review = {
  name: 'main: review',
  target: 'branch',
  enforcement: 'active',
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  bypass_actors: [{ actor_id: ADMIN_ROLE, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' }],
  rules: [
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 1,
        require_code_owner_review: true,
        dismiss_stale_reviews_on_push: true,
        require_last_push_approval: true,
        required_review_thread_resolution: false,
        allowed_merge_methods: ['squash'],
      },
    },
  ],
};

let repo = '';

function gh(method: string, path: string, body?: unknown): string {
  const args = ['api', '--method', method, `repos/${repo}${path}`, '-H', 'X-GitHub-Api-Version: 2022-11-28'];
  if (body !== undefined) args.push('--input', '-');
  return execFileSync('gh', args, { input: body === undefined ? '' : JSON.stringify(body), encoding: 'utf-8' });
}

function step(what: string, apply: () => unknown): void {
  apply();
  console.log(`  ✓ ${what}`);
}

const [only] = process.argv.slice(2);
if (only && !REPOSITORIES[only]) {
  console.error(`${only} is not one of ours. Choose from: ${Object.keys(REPOSITORIES).join(', ')}`);
  process.exit(1);
}

for (const [name, requiredChecks] of Object.entries(REPOSITORIES)) {
  if (only && name !== only) continue;
  repo = name;
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

  // Workflows start read-only and ask for more per job. None may open or approve a pull request: the factory's App
  // opens the deploy and release pull requests (ADR 0005), and a workflow's token never stands in for a reviewer.
  // Apply this only once both repositories' workflows have stopped opening pull requests (their matching pull
  // requests merged), or their build and release workflows fail.
  step('workflow tokens read-only by default; workflows may not open or approve pull requests', () =>
    gh('PUT', '/actions/permissions/workflow', {
      default_workflow_permissions: 'read',
      can_approve_pull_request_reviews: false,
    }),
  );

  step("first-time contributors' workflows wait for approval", () =>
    gh('PUT', '/actions/permissions/fork-pr-contributor-approval', { approval_policy: 'first_time_contributors' }),
  );

  // The release pull request carries release-please's labels; a deploy pull request, which the App opens, this one.
  const deployLabel = {
    name: 'deploy: local',
    color: '0e8a16',
    description: 'Moves an image pin in the local profile',
  };
  step(`label "${deployLabel.name}" for the deploy pull requests`, () => {
    const existing = JSON.parse(gh('GET', '/labels?per_page=100')) as { name: string }[];
    if (existing.some((l) => l.name === deployLabel.name))
      gh('PATCH', `/labels/${encodeURIComponent(deployLabel.name)}`, deployLabel);
    else gh('POST', '/labels', deployLabel);
  });

  const existing = JSON.parse(gh('GET', '/rulesets')) as { id: number; name: string }[];
  const apply = (ruleset: { name: string }) => {
    const id = existing.find((r) => r.name === ruleset.name)?.id;
    if (id) gh('PUT', `/rulesets/${id}`, ruleset);
    else gh('POST', '/rulesets', ruleset);
  };
  step(`ruleset "main": pull requests only, linear and signed; requires ${requiredChecks.join('; ')}`, () =>
    apply(rules(requiredChecks)),
  );
  step('ruleset "main: review": a code owner approves after the last push; the admin may bypass it to merge', () =>
    apply(review),
  );
}
