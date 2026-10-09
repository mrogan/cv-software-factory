import { describe, expect, it } from 'vitest';
import { DryRunActions, LiveActions } from '../../src/github/actions.ts';
import { APP_LOGIN, currentWatch } from '../../src/github/current.ts';
import { calls, client, quiet, type Sent } from './fake.ts';

const REPO = 'mrogan/cv-software-factory';
const sha = (n: number) => String(n).repeat(40).slice(0, 40);

/** Open pull requests, each with how far behind main it is, its reviews, and whether updating it conflicts. */
function repo(
  pulls: {
    number: number;
    login: string | null;
    behind: number;
    branch?: string;
    reviews?: string[];
    conflicts?: boolean;
  }[],
) {
  const sent: Sent[] = [];
  const of = (path: string) => pulls.find((p) => path.includes(`/${p.number}/`) || path.endsWith(sha(p.number)));
  return client(
    [
      {
        method: 'GET',
        path: `/repos/${REPO}/pulls?state=open&sort=created&direction=asc&per_page=50`,
        answer: () => ({
          body: pulls.map((p) => ({
            number: p.number,
            user: p.login === null ? null : { login: p.login },
            head: { ref: p.branch ?? `factory/${p.number}`, sha: sha(p.number) },
          })),
        }),
      },
      {
        method: 'GET',
        path: /\/compare\/main\.\.\./,
        answer: ({ path }) => ({ body: { behind_by: of(path)?.behind ?? 0 } }),
      },
      {
        method: 'GET',
        path: /\/pulls\/\d+\/reviews/,
        answer: ({ path }) => ({ body: (of(path)?.reviews ?? []).map((state) => ({ state })) }),
      },
      {
        method: 'PUT',
        path: /\/pulls\/\d+\/update-branch$/,
        answer: ({ path }) =>
          pulls.find((p) => path.includes(`/${p.number}/`))?.conflicts
            ? { status: 422, body: { message: 'merge conflict between base and head' } }
            : { status: 202, body: {} },
      },
    ],
    sent,
  );
}

const updates = (sent: Sent[]) =>
  calls(sent)
    .filter((s) => s.method === 'PUT')
    .map((s) => s.path.split('/').at(-2));

describe('keeping the App’s pull requests current', () => {
  it('updates its own that are behind and unapproved, and nobody else’s, nor a deleted account’s', async () => {
    const { github, sent } = repo([
      { number: 1, login: 'mrogan', behind: 2 },
      { number: 2, login: APP_LOGIN, behind: 2 },
      { number: 3, login: APP_LOGIN, behind: 2, reviews: ['COMMENTED', 'APPROVED'] },
      { number: 4, login: APP_LOGIN, behind: 0 },
      { number: 5, login: null, behind: 2 },
    ]);
    await currentWatch(github, new LiveActions(github), REPO, quiet)();
    expect(updates(sent)).toEqual(['2']);
  });

  it('leaves a deploy pull request to the deploy watch, the one writer to its branch', async () => {
    const { github, sent } = repo([
      { number: 2, login: APP_LOGIN, behind: 1, branch: 'deploy/factory-local' },
      { number: 3, login: APP_LOGIN, behind: 1, branch: 'deploy/console-local' },
      { number: 4, login: APP_LOGIN, behind: 1, branch: 'release-please--branches--main' },
    ]);
    await currentWatch(github, new LiveActions(github), REPO, quiet)();
    expect(updates(sent)).toEqual(['4']);
  });

  it('tries a head that conflicts once, and again only when it is pushed to', async () => {
    const { github, sent } = repo([{ number: 6, login: APP_LOGIN, behind: 3, conflicts: true }]);
    const pass = currentWatch(github, new LiveActions(github), REPO, quiet);
    await pass();
    await pass();
    expect(updates(sent)).toEqual(['6']);
  });

  it('updates from each head once, so a dry run records it once', async () => {
    const { github } = repo([{ number: 2, login: APP_LOGIN, behind: 1 }]);
    const actions = new DryRunActions({ put: async () => 'f'.repeat(64) } as never, quiet);
    const updated: number[] = [];
    actions.updateBranch = async (_repo, number) => void updated.push(number);
    const pass = currentWatch(github, actions, REPO, quiet);
    await pass();
    await pass();
    expect(updated).toEqual([2]);
  });
});
