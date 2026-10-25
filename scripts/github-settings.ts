/**
 * Applies the public repositories' GitHub settings, so they are reviewable like code and reproducible. Both get
 * the same ruleset, review environment and security settings; only the checks each requires differ. Safe to run again.
 *
 *     node scripts/github-settings.ts                  # every repository below
 *     node scripts/github-settings.ts <owner/repo>     # one of them
 *     node scripts/github-settings.ts --check          # change nothing: say where the live settings differ
 *
 * `--check` reads each repository's rulesets and its `review` environment and compares them with the ones here, and
 * names any ruleset it does not know, such as one added in the browser. It exits 1 if anything differs.
 *
 * Needs the GitHub CLI, signed in as an admin of the repository.
 */
import { execFileSync } from 'node:child_process';

/**
 * Each repository, and the jobs that must pass before anything merges into its main. A job in a shared workflow
 * reports as "<calling job> / <job>".
 */
export const REPOSITORIES: Record<string, string[]> = {
  'the-roganator/cv-software-factory': ['lint, types, tests', 'browser tests', 'image builds', 'pull request title'],
  // The app's gates come from this repository (app-gates.yml); tests first is a signal, not a requirement.
  'the-roganator/cv-worlds-worst-website': [
    'lint, types, tests',
    'image builds',
    'title / pull request title',
    'gates / journeys',
    'gates / test integrity',
    'gates / dependency review',
    'gates / image scan',
  ],
};

/** GitHub Actions, as the app that reports check runs. */
const GITHUB_ACTIONS = 15368;

/**
 * The review App (ADR 0014), as the app that reports the `review` check: Martin opened the pull request, or approved
 * its head. Required from this App alone, so a workflow's job of the same name never stands in for it.
 */
export const REVIEW_APP = 5470762;

/** The check the review App posts, `scripts/review-gate.ts`. */
export const REVIEW_CHECK = 'review';

/** The environment that holds the review App's key, and the one branch whose workflows may use it. */
export const REVIEW_ENVIRONMENT = 'review';
export const REVIEW_BRANCH = 'main';
/** The review App's key, as review.yml reads it from the environment. */
export const REVIEW_KEY = 'REVIEW_APP_PRIVATE_KEY';

/**
 * The one ruleset on main (ADR 0014), which nobody bypasses: every change is a pull request, squash-merged, signed
 * and linear, through the merge queue, once its required checks pass, `review` among them. GitHub's own review rule
 * is not here: the queue admits only a pull request that meets every rule, so review is a check it can wait for.
 *
 * No rule that a branch be up to date with main: the queue tests each pull request on main as it will be, with the
 * pull requests ahead of it, so one behind main merges without being brought up to date first.
 */
export const rules = (requiredChecks: string[]) => ({
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
        strict_required_status_checks_policy: false,
        do_not_enforce_on_create: false,
        required_status_checks: [
          ...requiredChecks.map((context) => ({ context, integration_id: GITHUB_ACTIONS })),
          { context: REVIEW_CHECK, integration_id: REVIEW_APP },
        ],
      },
    },
    { type: 'merge_queue', parameters: MERGE_QUEUE },
  ],
});

/**
 * The merge queue: each pull request squashed, as the repository merges, and every one of a group must pass, so each
 * commit on main is one whose checks passed. A run of the checks takes about five minutes, and a chain of their jobs
 * at most about forty, so a group whose checks say nothing within the hour is taken out of the queue. Up to five are
 * tested at once, each on main with the ones ahead of it, and a pull request merges as soon as its checks pass, with
 * no wait for others to group with: there are seldom more than a few, and each run is a full one.
 */
export const MERGE_QUEUE = {
  merge_method: 'SQUASH',
  grouping_strategy: 'ALLGREEN',
  max_entries_to_build: 5,
  min_entries_to_merge: 1,
  max_entries_to_merge: 5,
  min_entries_to_merge_wait_minutes: 0,
  check_response_timeout_minutes: 60,
};

/** Rulesets that were here once, and are deleted where they are found: GitHub's review rule (ADR 0009), now `review`. */
export const RETIRED = ['main: review'];

/**
 * The `review` environment, which holds the review App's key: only workflows on main may use it, so a pull request
 * into another branch, which runs that branch's copy of the gate, never reads the key (ADR 0014).
 */
export const environment = {
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
};
export const branchPolicies = [{ name: REVIEW_BRANCH, type: 'branch' }];

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

/**
 * Whether what GitHub holds says everything this script set. GitHub adds defaults of its own (such as
 * `required_reviewers: []`), so an object matches when each key this script set matches; a list must be as long, and
 * match item by item, so a bypass actor or a rule added elsewhere is drift.
 */
export function matches(live: unknown, wanted: unknown): boolean {
  if (Array.isArray(wanted)) {
    return Array.isArray(live) && live.length === wanted.length && wanted.every((w, i) => matches(live[i], w));
  }
  if (wanted && typeof wanted === 'object') {
    if (!live || typeof live !== 'object') return false;
    return Object.entries(wanted).every(([key, value]) => matches((live as Record<string, unknown>)[key], value));
  }
  return live === wanted;
}

/** Compares a repository's live rulesets and review environment with these, and says what differs. */
function check(requiredChecks: string[]): string[] {
  const wanted = [rules(requiredChecks)];
  const live = JSON.parse(gh('GET', '/rulesets')) as { id: number; name: string }[];
  const problems = live
    .filter((r) => !wanted.some((w) => w.name === r.name))
    .map((r) => `ruleset "${r.name}" is not one of these`);
  for (const ruleset of wanted) {
    const found = live.find((r) => r.name === ruleset.name);
    if (!found) problems.push(`ruleset "${ruleset.name}" is missing`);
    else if (!matches(JSON.parse(gh('GET', `/rulesets/${found.id}`)), ruleset)) {
      problems.push(`ruleset "${ruleset.name}" differs from this script's`);
    }
  }
  return [...problems, ...checkEnvironment()];
}

/** Compares the live `review` environment with this script's: present, and usable from main alone. */
function checkEnvironment(): string[] {
  const path = `/environments/${REVIEW_ENVIRONMENT}`;
  const live = found(() => JSON.parse(gh('GET', path)));
  if (live === undefined) return [`environment "${REVIEW_ENVIRONMENT}" is missing`];
  const policies = JSON.parse(gh('GET', `${path}/deployment-branch-policies`)) as { branch_policies: unknown[] };
  const problems = environmentProblems(live, policies.branch_policies);
  if (!hasKey()) problems.push(`environment "${REVIEW_ENVIRONMENT}" holds no ${REVIEW_KEY}`);
  return problems;
}

/** What a read answers, or undefined when GitHub says there is no such thing; any other failure is thrown. */
function found<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if (/HTTP 404/.test(String((error as { stderr?: unknown }).stderr ?? error))) return undefined;
    throw error;
  }
}

/** Whether the review environment holds the review App's key, by name: GitHub never shows a secret's value. */
function hasKey(): boolean {
  const secrets = found(
    () =>
      JSON.parse(gh('GET', `/environments/${REVIEW_ENVIRONMENT}/secrets?per_page=100`)) as {
        secrets: { name: string }[];
      },
  );
  return secrets?.secrets.some((s) => s.name === REVIEW_KEY) ?? false;
}

/** What differs between a live environment and its branch policies and this script's. */
export function environmentProblems(live: unknown, policies: unknown[]): string[] {
  const problems: string[] = [];
  if (!matches(live, environment)) {
    problems.push(`environment "${REVIEW_ENVIRONMENT}" is not limited to the branches it names`);
  }
  if (!matches(policies, branchPolicies)) {
    problems.push(`environment "${REVIEW_ENVIRONMENT}" may be used from other branches than ${REVIEW_BRANCH} alone`);
  }
  return problems;
}

function main(args: string[]): number {
  const checking = args.includes('--check');
  const only = args.find((a) => !a.startsWith('--'));
  if (only && !REPOSITORIES[only]) {
    console.error(`${only} is not one of ours. Choose from: ${Object.keys(REPOSITORIES).join(', ')}`);
    return 1;
  }
  let drift = false;
  for (const [name, requiredChecks] of Object.entries(REPOSITORIES)) {
    if (only && name !== only) continue;
    repo = name;
    if (checking) {
      const problems = check(requiredChecks);
      for (const p of problems) console.log(`  ✗ ${repo}: ${p}`);
      if (!problems.length) console.log(`  ✓ ${repo}: the rulesets are as this script makes them`);
      drift ||= problems.length > 0;
      continue;
    }
    apply(name, requiredChecks);
  }
  return drift ? 1 : 0;
}

function apply(name: string, requiredChecks: string[]): void {
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

  // The environment first: the ruleset requires the check the key in it posts.
  step(`environment "${REVIEW_ENVIRONMENT}": used only from ${REVIEW_BRANCH}`, () => {
    const path = `/environments/${REVIEW_ENVIRONMENT}`;
    gh('PUT', path, environment);
    const live = JSON.parse(gh('GET', `${path}/deployment-branch-policies`)) as {
      branch_policies: { id: number; name: string; type?: string }[];
    };
    for (const policy of live.branch_policies) {
      if (!branchPolicies.some((p) => p.name === policy.name && p.type === (policy.type ?? 'branch'))) {
        gh('DELETE', `${path}/deployment-branch-policies/${policy.id}`);
      }
    }
    for (const policy of branchPolicies) {
      if (!live.branch_policies.some((p) => p.name === policy.name && (p.type ?? 'branch') === policy.type)) {
        gh('POST', `${path}/deployment-branch-policies`, policy);
      }
    }
  });

  // Without the key, review.yml posts no check, and a ruleset requiring it would hold every pull request, the one that
  // fixes it included: nobody bypasses it. So the ruleset waits for the key (ADR 0014's order: key, a posted check,
  // then these settings).
  if (!hasKey()) {
    throw new Error(
      `${repo}: environment "${REVIEW_ENVIRONMENT}" holds no ${REVIEW_KEY}, so nothing would post the review check the ruleset requires. Add the key, see a review check posted, then run this again.`,
    );
  }

  const existing = JSON.parse(gh('GET', '/rulesets')) as { id: number; name: string }[];
  const apply = (ruleset: { name: string }) => {
    const id = existing.find((r) => r.name === ruleset.name)?.id;
    if (id) gh('PUT', `/rulesets/${id}`, ruleset);
    else gh('POST', '/rulesets', ruleset);
  };
  step(
    `ruleset "main": pull requests only, linear and signed, through the merge queue; requires ${[...requiredChecks, REVIEW_CHECK].join('; ')}`,
    () => apply(rules(requiredChecks)),
  );
  for (const name of RETIRED) {
    const id = existing.find((r) => r.name === name)?.id;
    if (id) step(`ruleset "${name}" deleted`, () => gh('DELETE', `/rulesets/${id}`));
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
