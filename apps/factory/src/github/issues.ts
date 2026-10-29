/**
 * Guardrail 10 (public means hostile), as the GitHub worker keeps it: the factory acts only on issues it opened, and
 * reads none as work. Martin asks the line for work with the console's "+"; no issue, and no label on one, does.
 *
 * - **The guard.** Commenting on, labelling, closing or reopening an issue the App did not open is refused before
 *   GitHub is asked, whoever asks: the line through the worker's step API, or a watch. Each refusal is kept as an
 *   `action.refused` record in the artifact store, logged with its hash, and the action fails with `IssueRefused`,
 *   which the worker answers 403, as GitHub answers an issue the App may not change. A pull request is an issue to
 *   GitHub, so one the App opened passes, as its issues do.
 * - **The reply.** An issue opened by anyone but Martin or the App gets one comment, `OUTSIDE_REPLY`, the one
 *   exception the guard makes, and only with those words: it echoes nothing of the issue, so nothing anyone writes
 *   in one is repeated by the App. Nothing else is done to it.
 * - **The watch.** Once a minute, with a conditional request, the worker reads each repository's newest open issues,
 *   and replies to each outside one it has not answered. It keeps no cursor: the worker touches no store. Saying it
 *   once is the memory (the live actions read an issue's comments before commenting), so a restarted worker reads
 *   the comments of each open outside issue once more, and says nothing twice.
 *
 * People are known by their numeric ids, which an account keeps when it is renamed, never by their logins.
 */

import type { PayloadOf } from '@software-factory/events';
import { PAYLOADS } from '@software-factory/events/schemas';
import type { ArtifactStore } from '@software-factory/store';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Actions } from './actions.ts';
import type { GitHub } from './client.ts';
import type { Watch } from './poller.ts';

/** Martin's GitHub account (`mrogan`), as `scripts/review-gate.ts` knows him. */
export const MARTIN = 6206459;

/** The App's bot account (`mrogan-software-factory[bot]`): the user that opens its issues and pull requests. */
export const APP_USER = 337_765_427;

/** What an issue opened by anyone else is told, once. Fixed: it says nothing of the issue, or of who opened it. */
export const OUTSIDE_REPLY = [
  'Thank you for opening this.',
  '',
  'This repository is looked after by an automated software factory. It acts only on what it finds itself and on ' +
    'what Martin asks of it, so it will not act on this issue. Martin reads every issue, and will read this one.',
].join('\n');

/** The issue actions the guard holds to the App's own issues. */
export type IssueAction = 'comment' | 'addLabels' | 'closeIssue' | 'reopenIssue';

/** What an issue's opener is, as the guard asks: their numeric id (null for a deleted account), and whether it is a pull request. */
export interface Opened {
  by: number | null;
  pullRequest: boolean;
}

export type OpenedBy = (repo: string, number: number) => Promise<Opened>;

const ISSUE = z.object({
  user: z.object({ id: z.number().int() }).nullable(),
  pull_request: z.unknown().optional(),
});

/** Who opened an issue or pull request, read from GitHub. One it does not have is GitHub's 404, and refuses nothing. */
export function openedBy(github: GitHub): OpenedBy {
  return async (repo, number) => {
    const issue = await github.read(repo, `/repos/${repo}/issues/${number}`, ISSUE);
    return { by: issue.user?.id ?? null, pullRequest: issue.pull_request !== undefined };
  };
}

/** Whether an issue's opener is someone the factory replies to: neither Martin nor the App. */
export const outside = (by: number | null) => by !== MARTIN && by !== APP_USER;

export class IssueRefused extends Error {
  override name = 'IssueRefused';
  readonly refusal: PayloadOf<'action.refused'>;
  /** The record's hash in the artifact store, when there is one. */
  readonly artifact: string | undefined;

  constructor(refusal: PayloadOf<'action.refused'>, artifact: string | undefined) {
    super(refusal.output);
    this.refusal = refusal;
    this.artifact = artifact;
  }
}

/** A refusal as the artifact store keeps it: an `action.refused` payload, and where and when. */
export interface RefusalRecord {
  type: 'action.refused';
  repo: string;
  number: number;
  at: string;
  payload: PayloadOf<'action.refused'>;
}

const DOING: Record<IssueAction, string> = {
  comment: 'Comment on',
  addLabels: 'Label',
  closeIssue: 'Close',
  reopenIssue: 'Reopen',
};

export interface IssueGuardOptions {
  openedBy: OpenedBy;
  /** Where each refusal is kept, and where it is logged; without either, it is only thrown. */
  artifacts?: ArtifactStore | undefined;
  log?: Logger | undefined;
  now?: () => Date;
}

export class IssueGuard {
  readonly #openedBy: OpenedBy;
  readonly #artifacts: ArtifactStore | undefined;
  readonly #log: Logger | undefined;
  readonly #now: () => Date;

  constructor({ openedBy, artifacts, log, now = () => new Date() }: IssueGuardOptions) {
    this.#openedBy = openedBy;
    this.#artifacts = artifacts;
    this.#log = log;
    this.#now = now;
  }

  /**
   * Passes an action on an issue or pull request the App opened, and the outside reply, word for word, on an issue
   * opened by anyone but Martin or the App. Anything else is recorded, and thrown as `IssueRefused`.
   */
  async check(repo: string, number: number, action: IssueAction, body?: string): Promise<void> {
    const opened = await this.#openedBy(repo, number);
    if (opened.by === APP_USER) return;
    if (action === 'comment' && body === OUTSIDE_REPLY && !opened.pullRequest && outside(opened.by)) return;
    const what = opened.pullRequest ? 'pull request' : 'issue';
    const payload = PAYLOADS['action.refused'].parse({
      mechanism: 'scope-fence',
      action: `${DOING[action]} ${what} #${number} in ${repo}`,
      output:
        `${repo}#${number} was opened by ${opened.by === null ? 'a deleted account' : `user ${opened.by}`}, ` +
        `not the factory's App: the factory acts only on the issues it opened (guardrail 10).`,
    });
    const record: RefusalRecord = { type: 'action.refused', repo, number, at: this.#now().toISOString(), payload };
    const artifact = await this.#artifacts?.put(new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`));
    this.#log?.warn(
      { action, repo, issue: number, openedBy: opened.by, artifact },
      'refused an issue the App did not open',
    );
    throw new IssueRefused(payload, artifact);
  }
}

const OPEN_ISSUES = z.array(
  z.object({
    number: z.number().int().positive(),
    // GitHub gives a deleted account as null.
    user: z.object({ id: z.number().int() }).nullable(),
    pull_request: z.unknown().optional(),
  }),
);

/**
 * Watches a repository's open issues, newest first, and says `OUTSIDE_REPLY` once on each opened by anyone but
 * Martin or the App. A hundred at a minute's interval: more than that are not opened here in a minute. An issue whose
 * reply failed is tried again at the next poll, without holding back the others.
 */
export function outsideIssuesWatch(
  github: GitHub,
  repo: string,
  actions: Pick<Actions, 'comment' | 'dryRun'>,
  log: Logger,
): Watch {
  const answered = new Set<number>();
  let first = true;
  let retry = false;
  return async () => {
    const { changed, body } = await github.poll(
      repo,
      `/repos/${repo}/issues?state=open&sort=created&direction=desc&per_page=100`,
      OPEN_ISSUES,
    );
    if (!changed && !retry) return;
    const issues = body.filter((issue) => issue.pull_request === undefined);
    const due = issues.filter((issue) => !answered.has(issue.number) && outside(issue.user?.id ?? null));
    for (const issue of issues) if (!outside(issue.user?.id ?? null)) answered.add(issue.number);
    if (first) log.info({ repo, open: issues.length, outside: due.length }, 'read the open issues');
    else log.debug({ repo, open: issues.length, outside: due.length }, 'the open issues changed');
    first = false;
    let failure: unknown;
    for (const { number } of due) {
      try {
        await actions.comment(repo, number, OUTSIDE_REPLY);
        answered.add(number);
        log.info({ repo, issue: number, dryRun: actions.dryRun }, 'replied to an issue opened outside the factory');
      } catch (error) {
        failure ??= error;
      }
    }
    retry = failure !== undefined;
    if (failure) throw failure;
  };
}
