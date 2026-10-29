import { describe, expect, it } from 'vitest';
import { APP_SLUG } from '../apps/factory/src/line/gates.ts';
import { REVIEW_CHECK as REVIEWER_CHECK } from '../apps/factory/src/line/review.ts';
import {
  APPS,
  branchPolicies,
  DRIFT_CHECK_ENVIRONMENT,
  ENVIRONMENTS,
  environment,
  environmentProblems,
  GITHUB_ACTIONS,
  MERGE_QUEUE,
  matches,
  REPOSITORIES,
  RETIRED,
  REVIEW_APP,
  REVIEW_ENVIRONMENT,
  rules,
  rulesetProblems,
} from './github-settings.ts';

const [checks] = Object.values(REPOSITORIES) as [string[]];
/** The parameters of one rule of a ruleset. */
const parametersOf = (ruleset: ReturnType<typeof rules>, type: string) =>
  (ruleset.rules.find((r) => r.type === type) as { parameters: Record<string, unknown> }).parameters;
const parameters = (type: string) => parametersOf(rules(checks), type);

describe('the ruleset on main (ADR 0014)', () => {
  it('lets nobody bypass the checks, signatures, history or queue', () => {
    for (const checks of Object.values(REPOSITORIES)) expect(rules(checks).bypass_actors).toEqual([]);
  });

  it('requires review from the review App alone, and every other check from GitHub Actions', () => {
    for (const checks of Object.values(REPOSITORIES)) {
      const required = parametersOf(rules(checks), 'required_status_checks').required_status_checks as {
        context: string;
        integration_id: number;
      }[];
      expect(required.filter((c) => c.context === 'review')).toEqual([
        { context: 'review', integration_id: REVIEW_APP },
      ]);
      expect(required.filter((c) => c.context !== 'review').map((c) => c.context)).toEqual(checks);
      expect(required.filter((c) => c.context !== 'review').every((c) => c.integration_id === 15368)).toBe(true);
    }
    expect(REVIEW_APP).toBe(5470762);
  });

  it('merges through the queue, squashed, with no rule that a branch be up to date and no GitHub review rule', () => {
    expect(parameters('merge_queue')).toEqual(MERGE_QUEUE);
    expect(MERGE_QUEUE).toMatchObject({ merge_method: 'SQUASH', grouping_strategy: 'ALLGREEN' });
    expect(parameters('required_status_checks')).toMatchObject({ strict_required_status_checks_policy: false });
    expect(parameters('pull_request')).toMatchObject({
      required_approving_review_count: 0,
      require_code_owner_review: false,
      allowed_merge_methods: ['squash'],
    });
    expect(RETIRED).toEqual(['main: review']);
  });

  it('lets no model decide a merge: no required check is the reviewer agent’s, or posted by the factory’s App', () => {
    expect(GITHUB_ACTIONS).toBe(15368);
    expect(APPS.factory.slug).toBe(APP_SLUG);
    for (const checks of Object.values(REPOSITORIES)) {
      const required = parametersOf(rules(checks), 'required_status_checks').required_status_checks as {
        context: string;
        integration_id: number;
      }[];
      expect(required.map((c) => c.context)).not.toContain(REVIEWER_CHECK);
      // Pinned to the app that must post it, so the factory's App's check run of the same name never stands in.
      for (const { integration_id } of required) {
        expect([GITHUB_ACTIONS, REVIEW_APP]).toContain(integration_id);
        expect(integration_id).not.toBe(APPS.factory.id);
      }
    }
  });

  it('sees drift: a bypass actor added in the browser, or a setting changed', () => {
    const wanted = rules(checks);
    const live = { ...wanted, id: 7, bypass_actors: [...wanted.bypass_actors], rules: structuredClone(wanted.rules) };
    expect(matches(live, wanted)).toBe(true);
    live.bypass_actors.push({ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' } as never);
    expect(matches(live, wanted)).toBe(false);
    const changed = structuredClone(wanted);
    parametersOf(changed, 'required_status_checks').strict_required_status_checks_policy = true;
    expect(matches(changed, wanted)).toBe(false);
  });
});

describe('a ruleset read without the right to change it', () => {
  it('is drift of its own, never read as nobody bypassing it, and the rest is still compared', () => {
    const wanted = rules(checks);
    expect(rulesetProblems(structuredClone(wanted), wanted)).toEqual([]);
    const { bypass_actors: _, ...unseen } = structuredClone(wanted);
    expect(rulesetProblems(unseen, wanted)).toEqual([
      'ruleset "main": this token cannot see who may bypass it, which GitHub shows only to those who may change it',
    ]);
    parametersOf(unseen as typeof wanted, 'pull_request').allowed_merge_methods = ['merge'];
    expect(rulesetProblems(unseen, wanted)).toHaveLength(2);
  });
});

describe('the GitHub Apps', () => {
  it('may none of them write variables, or administer a repository', () => {
    for (const [name, app] of Object.entries(APPS)) {
      const permissions: Record<string, string> = app.permissions;
      expect(permissions.variables, name).not.toBe('write');
      expect(permissions.administration, name).not.toBe('write');
      // Nor change a workflow, or a secret or an environment that holds one.
      for (const p of ['workflows', 'secrets', 'environments', 'actions_variables', 'organization_administration']) {
        expect(permissions[p], `${name}: ${p}`).not.toBe('write');
      }
    }
  });

  it('are as GitHub shows them: the factory’s writes its pull requests, the others read, but for the review check', () => {
    expect(APPS.factory.permissions).toEqual({
      checks: 'write',
      contents: 'write',
      issues: 'write',
      metadata: 'read',
      pull_requests: 'write',
    });
    expect(APPS.review).toMatchObject({ id: REVIEW_APP });
    expect(APPS.review.permissions).toEqual({ checks: 'write', metadata: 'read', pull_requests: 'read' });
    expect(Object.values(APPS.driftCheck.permissions)).toEqual(['read', 'read', 'read', 'read']);
  });
});

describe('the environments that hold a key', () => {
  it('are review in both repositories, and the drift check in this one alone', () => {
    expect(Object.keys(ENVIRONMENTS)).toEqual(Object.keys(REPOSITORIES));
    expect(ENVIRONMENTS['the-roganator/cv-software-factory']).toEqual([REVIEW_ENVIRONMENT, DRIFT_CHECK_ENVIRONMENT]);
    expect(ENVIRONMENTS['the-roganator/cv-worlds-worst-website']).toEqual([REVIEW_ENVIRONMENT]);
  });
});

describe('the review environment', () => {
  const live = {
    name: 'review',
    protection_rules: [{ id: 1, type: 'branch_policy' }],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    can_admins_bypass: true,
  };
  const main = [{ id: 64334180, node_id: 'x', name: 'main', type: 'branch' }];

  it('is as Martin set it by hand: used from main alone', () => {
    expect(environment.deployment_branch_policy).toEqual({ protected_branches: false, custom_branch_policies: true });
    expect(branchPolicies).toEqual([{ name: 'main', type: 'branch' }]);
    expect(environmentProblems('review', live, main)).toEqual([]);
  });

  it('is drift when any branch, protected branches, or another branch may use it', () => {
    expect(environmentProblems('review', { ...live, deployment_branch_policy: null }, [])).toHaveLength(2);
    expect(
      environmentProblems(
        'review',
        { ...live, deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } },
        main,
      ),
    ).toEqual(['environment "review" is not limited to the branches it names']);
    expect(
      environmentProblems('review', live, [...main, { id: 2, name: 'gh-readonly-queue/*', type: 'branch' }]),
    ).toEqual(['environment "review" may be used from other branches than main alone']);
    expect(environmentProblems('review', live, [{ id: 3, name: 'main', type: 'tag' }])).toHaveLength(1);
  });
});
