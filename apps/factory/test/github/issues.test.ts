import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAYLOADS } from '@software-factory/events/schemas';
import { DiskArtifacts } from '@software-factory/store';
import { listenLocal } from '@software-factory/testing';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { MARTIN as REVIEW_GATE_MARTIN } from '../../../../scripts/review-gate.ts';
import { DRY_RUN_NUMBERS_FROM, DryRunActions, LiveActions } from '../../src/github/actions.ts';
import {
  APP_USER,
  IssueGuard,
  IssueRefused,
  MARTIN,
  OUTSIDE_REPLY,
  openedBy,
  outsideIssuesWatch,
} from '../../src/github/issues.ts';
import { createWorkerServer } from '../../src/github/server.ts';
import { GitHubWorker } from '../../src/github/worker-client.ts';
import { closeIssue } from '../../src/line/issues.ts';
import { calls, client, quiet, REPO, type Route } from './fake.ts';

const SOMEONE = 4242;
const AT = () => new Date('2026-10-29T12:00:00Z');

/** GitHub's issues, by number: who opened each, and whether it is a pull request. */
const ISSUES: Record<number, { by: number | null; pullRequest?: boolean }> = {
  16: { by: APP_USER },
  17: { by: APP_USER, pullRequest: true },
  120: { by: MARTIN },
  121: { by: MARTIN, pullRequest: true },
  130: { by: SOMEONE },
  131: { by: SOMEONE, pullRequest: true },
  140: { by: null },
};

/** GitHub as the issue actions find it: each issue as `ISSUES` has it, open, with no comments, taking every write. */
function github(extra: Route[] = []) {
  const comments = new Map<number, { body: string }[]>();
  return {
    comments,
    ...client([
      ...extra,
      {
        method: 'GET',
        path: /^\/repos\/[^/]+\/[^/]+\/issues\/\d+$/,
        answer: ({ path }) => {
          const issue = ISSUES[Number(path.split('/').at(-1))];
          if (!issue) return { status: 404, body: { message: 'Not Found' } };
          return {
            body: {
              state: 'open',
              user: issue.by === null ? null : { id: issue.by },
              ...(issue.pullRequest ? { pull_request: {} } : {}),
            },
          };
        },
      },
      { method: 'GET', path: /\/issues\/\d+\/events/, answer: () => ({ body: [] }) },
      {
        method: 'GET',
        path: /\/issues\/\d+\/comments/,
        answer: ({ path }) => ({ body: comments.get(Number(path.split('/').at(-2))) ?? [] }),
      },
      {
        method: 'POST',
        path: /\/issues\/\d+\/comments$/,
        answer: ({ path, body }) => {
          const number = Number(path.split('/').at(-2));
          comments.set(number, [...(comments.get(number) ?? []), body as { body: string }]);
          return { status: 201, body: {} };
        },
      },
      { method: 'POST', path: /\/issues\/\d+\/labels$/, answer: () => ({ body: [] }) },
      { method: 'PATCH', path: /\/issues\/\d+$/, answer: () => ({ body: {} }) },
      { method: 'PATCH', path: /\/pulls\/\d+$/, answer: () => ({ body: {} }) },
    ]),
  };
}

const writes = (sent: { method: string }[]) => calls(sent as never).filter((s) => s.method !== 'GET');

async function records(dir: string) {
  return Promise.all((await readdir(dir)).map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf-8'))));
}

describe('the issue guard', () => {
  it('knows Martin as the review gate does', () => {
    expect(MARTIN).toBe(REVIEW_GATE_MARTIN);
  });

  it('acts on the issues and pull requests the App opened', async () => {
    const { github: gh, sent } = github();
    const actions = new LiveActions(gh);
    await actions.closeIssue(REPO, 16, 'completed', 'Verified in production.');
    await actions.reopenIssue(REPO, 16, 'It came back.'); // open, so it says nothing and changes nothing
    await actions.comment(REPO, 16, 'Released behind its flag.');
    await actions.comment(REPO, 17, 'A word on its own pull request.');
    await actions.addLabels(REPO, 17, ['deploy: local']);
    expect(writes(sent).map((s) => `${s.method} ${s.path}`)).toEqual([
      `POST /repos/${REPO}/issues/16/comments`,
      `PATCH /repos/${REPO}/issues/16`,
      `POST /repos/${REPO}/issues/16/comments`,
      `POST /repos/${REPO}/issues/17/comments`,
      `POST /repos/${REPO}/issues/17/labels`,
    ]);
  });

  it('refuses every issue action on one the App did not open, before GitHub is asked to change anything', async () => {
    const { github: gh, sent } = github();
    const actions = new LiveActions(gh);
    const attempts: [string, () => Promise<unknown>][] = [
      ["close Martin's issue", () => actions.closeIssue(REPO, 120, 'not_planned', 'Not planned.')],
      ["close Martin's issue without a word", () => actions.closeIssue(REPO, 120, 'completed')],
      ["reopen Martin's issue", () => actions.reopenIssue(REPO, 120, 'It came back.')],
      ["comment on Martin's issue", () => actions.comment(REPO, 120, 'Hello.')],
      ["comment on Martin's pull request", () => actions.comment(REPO, 121, 'Hello.')],
      ["label Martin's pull request", () => actions.addLabels(REPO, 121, ['factory'])],
      ["close an outsider's issue", () => actions.closeIssue(REPO, 130, 'completed')],
      ["comment on an outsider's issue in other words", () => actions.comment(REPO, 130, 'Thanks!')],
      ["label an outsider's issue", () => actions.addLabels(REPO, 130, ['bug'])],
      ["reply to an outsider's pull request", () => actions.comment(REPO, 131, OUTSIDE_REPLY)],
      ["reply to Martin's issue", () => actions.comment(REPO, 120, OUTSIDE_REPLY)],
      ["close a deleted account's issue", () => actions.closeIssue(REPO, 140, 'completed')],
    ];
    for (const [what, attempt] of attempts) {
      await expect(attempt(), what).rejects.toBeInstanceOf(IssueRefused);
    }
    expect(writes(sent)).toEqual([]);
  });

  it('lets the outside reply alone through, word for word, on an issue opened by anyone but Martin or the App', async () => {
    const { github: gh, comments } = github();
    const actions = new LiveActions(gh);
    await actions.comment(REPO, 130, OUTSIDE_REPLY);
    await actions.comment(REPO, 140, OUTSIDE_REPLY);
    await actions.comment(REPO, 130, OUTSIDE_REPLY); // said already: said once
    expect(comments.get(130)).toEqual([{ body: OUTSIDE_REPLY }]);
    expect(comments.get(140)).toEqual([{ body: OUTSIDE_REPLY }]);
  });

  it('keeps each refusal as a valid action.refused in the artifact store, and logs its hash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'refusals-'));
    const logged: Record<string, unknown>[] = [];
    const log = pino({ level: 'warn' }, { write: (line: string) => void logged.push(JSON.parse(line)) });
    const { github: gh } = github();
    const guard = new IssueGuard({ openedBy: openedBy(gh), artifacts: new DiskArtifacts(dir), log, now: AT });
    const refused = await new LiveActions(gh, { guard })
      .closeIssue(REPO, 120, 'not_planned')
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(IssueRefused);
    const [record] = await records(dir);
    expect(record).toEqual({
      type: 'action.refused',
      repo: REPO,
      number: 120,
      at: '2026-10-29T12:00:00.000Z',
      payload: {
        mechanism: 'scope-fence',
        action: `Close issue #120 in ${REPO}`,
        output: `${REPO}#120 was opened by user ${MARTIN}, not the factory's App: the factory acts only on the issues and pull requests it opened (guardrail 10).`,
      },
    });
    expect(PAYLOADS['action.refused'].safeParse(record.payload).success).toBe(true);
    expect((refused as IssueRefused).artifact).toMatch(/^[0-9a-f]{64}$/);
    expect(logged.find((l) => l.msg === 'refused an issue the App did not open')).toMatchObject({
      action: 'closeIssue',
      issue: 120,
      openedBy: MARTIN,
      artifact: (refused as IssueRefused).artifact,
    });
  });
});

describe('the guard on pull requests', () => {
  it('updates a pull request the App opened, and refuses, and records, one anyone else opened', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'refusals-'));
    const { github: gh, sent } = github();
    const guard = new IssueGuard({ openedBy: openedBy(gh), artifacts: new DiskArtifacts(dir), log: quiet, now: AT });
    const actions = new LiveActions(gh, { guard });
    await actions.updatePullRequest(REPO, 17, { title: 'fix(search): escape the quote', body: 'Described.' });
    await expect(actions.updatePullRequest(REPO, 121, { body: 'Rewritten.' })).rejects.toBeInstanceOf(IssueRefused);
    await expect(actions.updatePullRequest(REPO, 131, { title: 'x' })).rejects.toBeInstanceOf(IssueRefused);
    expect(writes(sent).map((s) => `${s.method} ${s.path}`)).toEqual([`PATCH /repos/${REPO}/pulls/17`]);
    expect((await records(dir)).map((r) => r.payload.action).sort()).toEqual([
      `Update pull request #121 in ${REPO}`,
      `Update pull request #131 in ${REPO}`,
    ]);
  });

  it('updates in a dry run the pull requests it opened without asking GitHub, and refuses one Martin opened', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dry-run-'));
    const { github: gh, sent } = github();
    const artifacts = new DiskArtifacts(dir);
    const guard = new IssueGuard({ openedBy: openedBy(gh), artifacts, log: quiet, now: AT });
    const actions = new DryRunActions(artifacts, quiet, AT, undefined, guard);
    const pr = await actions.openPullRequest(REPO, { head: 'factory/1001-cart', base: 'main', title: 't', body: 'b' });
    await actions.updatePullRequest(REPO, pr.number, { body: 'Described.' });
    expect(calls(sent)).toEqual([]);
    await expect(actions.updatePullRequest(REPO, 121, { body: 'Rewritten.' })).rejects.toBeInstanceOf(IssueRefused);
    const kept = await records(dir);
    expect(kept.filter((r) => r.action === 'updatePullRequest').map((r) => r.args.number)).toEqual([pr.number]);
    expect(kept.filter((r) => r.type === 'action.refused')).toHaveLength(1);
  });
});

describe('the issue guard in a dry run', () => {
  async function dryRun() {
    const dir = await mkdtemp(join(tmpdir(), 'dry-run-'));
    const { github: gh, sent } = github();
    const artifacts = new DiskArtifacts(dir);
    const guard = new IssueGuard({ openedBy: openedBy(gh), artifacts, log: quiet, now: AT });
    const actions = new DryRunActions(artifacts, quiet, AT, undefined, guard);
    return { dir, sent, actions, guard, artifacts };
  }

  it('closes the issues it opened without asking GitHub, even once the worker has started again', async () => {
    const { dir, sent, actions, guard, artifacts } = await dryRun();
    const issue = await actions.openIssue(REPO, { title: 'A broken link', body: '…' });
    expect(issue).toBeGreaterThan(DRY_RUN_NUMBERS_FROM);
    await actions.closeIssue(REPO, issue, 'completed', 'Verified in production.');
    // Started again, it remembers nothing, and a dry run's number is still its own.
    const again = new DryRunActions(artifacts, quiet, AT, undefined, guard);
    await again.reopenIssue(REPO, issue, 'It came back.');
    await again.comment(REPO, issue, 'Released behind its flag.');
    expect(calls(sent)).toEqual([]);
    expect((await records(dir)).map((r) => r.action).sort()).toEqual([
      'closeIssue',
      'comment',
      'openIssue',
      'reopenIssue',
    ]);
  });

  it('passes a real issue the App opened, and refuses, and records the refusal of, one it did not', async () => {
    const { dir, actions } = await dryRun();
    await actions.closeIssue(REPO, 16, 'completed');
    await expect(actions.closeIssue(REPO, 120, 'completed')).rejects.toBeInstanceOf(IssueRefused);
    await expect(actions.comment(REPO, 120, 'Hello.')).rejects.toBeInstanceOf(IssueRefused);
    await actions.comment(REPO, 130, OUTSIDE_REPLY);
    const kept = await records(dir);
    expect(kept.filter((r) => r.action).map((r) => [r.action, r.args.number])).toEqual(
      expect.arrayContaining([
        ['closeIssue', 16],
        ['comment', 130],
      ]),
    );
    expect(kept.filter((r) => r.action)).toHaveLength(2);
    expect(
      kept
        .filter((r) => r.type === 'action.refused')
        .map((r) => r.payload.action)
        .sort(),
    ).toEqual([`Close issue #120 in ${REPO}`, `Comment on issue #120 in ${REPO}`]);
  });

  it('refuses again a comment it refused, rather than taking it as said', async () => {
    const { actions } = await dryRun();
    await expect(actions.comment(REPO, 120, 'Hello.')).rejects.toBeInstanceOf(IssueRefused);
    await expect(actions.comment(REPO, 120, 'Hello.')).rejects.toBeInstanceOf(IssueRefused);
  });
});

describe('the issue guard over HTTP, as the line asks', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  it("answers a refusal 403, naming its record, and the line's close of an issue leaves it and goes on", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dry-run-'));
    const { github: gh } = github();
    const artifacts = new DiskArtifacts(dir);
    const made = new DryRunActions(
      artifacts,
      quiet,
      AT,
      undefined,
      new IssueGuard({ openedBy: openedBy(gh), artifacts, log: quiet, now: AT }),
    );
    const server = createWorkerServer({
      actions: made,
      dryRun: made,
      repositories: [REPO],
      health: () => ({}),
      log: quiet,
    });
    const { url } = await listenLocal(server);
    close = () => server.close();

    const answer = await fetch(`${url}/v1/actions/closeIssue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO, number: 120, reason: 'not_planned' }),
    });
    expect(answer.status).toBe(403);
    const body = (await answer.json()) as { error: string; message: string; artifact: string };
    expect(body).toMatchObject({ error: 'issue-refused', message: expect.stringContaining('guardrail 10') });
    expect(JSON.parse(await readFile(join(dir, body.artifact), 'utf-8'))).toMatchObject({
      type: 'action.refused',
      number: 120,
    });

    // The line in dry-run: the issue its dry run opened closes; one the App did not open is left, and logged.
    const worker = new GitHubWorker(url, { dryRun: true });
    const warned: unknown[] = [];
    const log = { warn: (...args: unknown[]) => void warned.push(args) };
    const issue = await worker.act('openIssue', REPO, { title: 'A broken link', body: '…' }, { workItem: '1001' });
    await closeIssue(worker, REPO, { number: issue, reason: 'completed', comment: 'Verified.' }, '1001', log);
    await closeIssue(worker, REPO, { number: 120, reason: 'completed', comment: 'Verified.' }, '1002', log);
    expect(warned).toHaveLength(1);
    const kept = await records(dir);
    expect(kept.filter((r) => r.action === 'closeIssue').map((r) => r.args.number)).toEqual([issue]);
    // Refused twice, at the same moment, in the same words: the store keeps one record of it, by its hash.
    expect(kept.filter((r) => r.type === 'action.refused')).toHaveLength(1);
  });
});

describe('the watch of new issues', () => {
  /** The newest open issues, as GitHub lists them, answered conditionally. */
  function listed(open: { number: number; by: number | null; pullRequest?: boolean }[]) {
    let etag = 1;
    const list = {
      set(next: typeof open) {
        open = next;
        etag += 1;
      },
      route: {
        method: 'GET',
        path: `/repos/${REPO}/issues?state=open&sort=created&direction=desc&per_page=100`,
        answer: ({ headers }) =>
          headers['if-none-match'] === `"${etag}"`
            ? { status: 304 }
            : {
                headers: { etag: `"${etag}"` },
                body: open.map((i) => ({
                  number: i.number,
                  user: i.by === null ? null : { id: i.by },
                  ...(i.pullRequest ? { pull_request: {} } : {}),
                })),
              },
      } satisfies Route,
    };
    return list;
  }

  it("replies once to each issue opened outside, and to nothing of Martin's or the App's", async () => {
    const list = listed([
      { number: 120, by: MARTIN },
      { number: 16, by: APP_USER },
      { number: 131, by: SOMEONE, pullRequest: true },
    ]);
    const { github: gh, sent, comments } = github([list.route]);
    const logged: Record<string, unknown>[] = [];
    const log = pino({ level: 'info' }, { write: (line: string) => void logged.push(JSON.parse(line)) });
    const watch = outsideIssuesWatch(gh, REPO, new LiveActions(gh), log);
    await watch(); // today's issues: none is due a reply
    expect(writes(sent)).toEqual([]);
    expect(logged.find((l) => l.msg === 'read the open issues')).toMatchObject({ repo: REPO, open: 2, outside: 0 });

    list.set([{ number: 130, by: SOMEONE }, ...[120, 16].map((n) => ({ number: n, by: ISSUES[n]?.by ?? null }))]);
    await watch();
    await watch(); // 304: nothing more
    expect(comments.get(130)).toEqual([{ body: OUTSIDE_REPLY }]);
    expect(writes(sent)).toHaveLength(1);
    expect(logged.filter((l) => l.msg === 'replied to an issue opened outside the factory')).toEqual([
      expect.objectContaining({ repo: REPO, issue: 130, dryRun: false }),
    ]);

    // Started again: it reads the outside issue's comments once more, and says nothing twice.
    await outsideIssuesWatch(gh, REPO, new LiveActions(gh), quiet)();
    expect(comments.get(130)).toEqual([{ body: OUTSIDE_REPLY }]);
  });

  it('tries a reply that failed again at the next poll, though the list has not changed', async () => {
    const list = listed([
      { number: 130, by: SOMEONE },
      { number: 140, by: null },
    ]);
    let fail = 1;
    const { github: gh, comments } = github([
      list.route,
      {
        method: 'POST',
        path: `/repos/${REPO}/issues/130/comments`,
        answer: ({ body }) => {
          if (fail-- > 0) return { status: 502, body: { message: 'Bad Gateway' } };
          comments.set(130, [body as { body: string }]);
          return { status: 201, body: {} };
        },
      },
    ]);
    const watch = outsideIssuesWatch(gh, REPO, new LiveActions(gh), quiet);
    await expect(watch()).rejects.toThrow();
    // The one after it was not held back.
    expect(comments.get(140)).toEqual([{ body: OUTSIDE_REPLY }]);
    await watch();
    expect(comments.get(130)).toEqual([{ body: OUTSIDE_REPLY }]);
  });

  it('records the reply in a dry run, and sends nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dry-run-'));
    const list = listed([{ number: 130, by: SOMEONE }]);
    const { github: gh, sent } = github([list.route]);
    const artifacts = new DiskArtifacts(dir);
    const guard = new IssueGuard({ openedBy: openedBy(gh), artifacts, log: quiet, now: AT });
    const watch = outsideIssuesWatch(gh, REPO, new DryRunActions(artifacts, quiet, AT, undefined, guard), quiet);
    await watch();
    await watch();
    expect(writes(sent)).toEqual([]);
    expect(await records(dir)).toEqual([
      { action: 'comment', repo: REPO, at: '2026-10-29T12:00:00.000Z', args: { number: 130, body: OUTSIDE_REPLY } },
    ]);
  });
});

describe('the outside reply', () => {
  it('is short, and names no one but Martin', () => {
    expect(OUTSIDE_REPLY.length).toBeLessThan(400);
    expect(OUTSIDE_REPLY).toContain('Martin reads every issue');
    expect(OUTSIDE_REPLY).not.toMatch(/@|\$\{|https?:/);
  });
});
