import { describe, expect, it } from 'vitest';
import { matches, REPOSITORIES, review, rules } from './github-settings.ts';

describe('the rulesets on main (ADR 0009)', () => {
  it('let nobody bypass the checks, signatures and history', () => {
    for (const checks of Object.values(REPOSITORIES)) expect(rules(checks).bypass_actors).toEqual([]);
  });

  it('let only the admin role bypass review, and only to merge a pull request; never the App', () => {
    expect(review.bypass_actors).toEqual([{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' }]);
    expect(review.bypass_actors.some((a) => (a.actor_type as string) === 'Integration')).toBe(false);
    expect(review.rules[0]?.parameters).toMatchObject({
      required_approving_review_count: 1,
      require_code_owner_review: true,
      require_last_push_approval: true,
    });
  });

  it('see drift: a bypass actor added in the browser, or a setting changed', () => {
    const live = { ...review, id: 7, bypass_actors: [...review.bypass_actors], rules: structuredClone(review.rules) };
    expect(matches(live, review)).toBe(true);
    live.bypass_actors.push({ actor_id: 1, actor_type: 'Integration', bypass_mode: 'always' } as never);
    expect(matches(live, review)).toBe(false);
    const changed = structuredClone(review);
    (changed.rules[0]?.parameters as Record<string, unknown>).require_code_owner_review = false;
    expect(matches(changed, review)).toBe(false);
  });
});
