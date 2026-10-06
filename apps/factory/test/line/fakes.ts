/**
 * Stand-ins for the line's two collaborators beyond the store: the runners, which hand back what each test's agents
 * say and write their calls to `model_calls` as the gateway would; and the GitHub worker, a repository in memory with
 * pull requests, check runs and issues.
 */
import type { Sql } from 'postgres';
import type { Handback } from '../../../runner/src/step.ts';
import type { CheckRun, Comparison, PullRequestState } from '../../src/github/reads.ts';
import type { ActionArgs, ActionName, ActionResult, ReadArgs, ReadName, ReadResult } from '../../src/github/server.ts';
import type { GitHubPort, Steps } from '../../src/line/worker.ts';
import { jobName } from '../../src/runners/jobs.ts';
import type { StepOutcome, StepRequest } from '../../src/runners/steps.ts';

export const MAIN = 'a'.repeat(40);

/** What an agent does with a step: hands something back, fails, or works until the line stops it. */
export type Agent = (
  request: StepRequest,
) => Handback | 'fails' | 'works on' | Promise<Handback | 'fails' | 'works on'>;

export class FakeSteps implements Steps {
  readonly requests: StepRequest[] = [];
  readonly finished: string[] = [];
  /** How many times deleting a work item's volume fails before it works. */
  finishFails = 0;
  readonly #agents: Partial<Record<string, Agent>>;
  readonly #sql: Sql;
  #working: (() => void)[] = [];

  constructor(sql: Sql, agents: Partial<Record<string, Agent>>) {
    this.#sql = sql;
    this.#agents = agents;
  }

  async run(request: StepRequest): Promise<StepOutcome> {
    const job = jobName(request.agent, request.workItem, request.round, request.attempt);
    // As the runners do: a step stopped before it starts never reaches its agent.
    if (request.signal?.aborted) return { kind: 'stopped', job };
    this.requests.push(request);
    const agent = this.#agents[request.agent];
    if (!agent) throw new Error(`No fake ${request.agent}`);
    const answer = await agent(request);
    if (answer === 'works on') {
      let stop = () => {};
      await new Promise<void>((resolve) => {
        stop = resolve;
        this.#working.push(resolve);
        request.signal?.addEventListener('abort', () => resolve());
      });
      this.#working = this.#working.filter((other) => other !== stop);
      return { kind: 'stopped', job };
    }
    // Two calls through the gateway, and one it refused, which is not counted.
    for (const [outcome, cost] of [
      ['answered', 0.01],
      ['answered', 0.02],
      ['refused', 0],
    ] as const) {
      await this.#sql`
        insert into model_calls (id, agent, work_item, provider, model, question_set, input_tokens, output_tokens,
                                 cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, outcome, job)
        values (${crypto.randomUUID()}, ${request.agent}, ${request.workItem}, 'local', 'qwen/qwen3.8-27b', 'messages',
                100, 20, 50, 10, ${cost}, 1000, ${outcome}, ${job})`;
    }
    if (answer === 'fails')
      return { kind: 'failed', job, reason: 'The agent pod failed without handing anything back.' };
    return { kind: 'handed-back', job, handback: answer };
  }

  async finish(workItem: string): Promise<void> {
    if (this.finishFails-- > 0) throw new Error('The volume could not be deleted.');
    this.finished.push(workItem);
  }

  async cancel(): Promise<void> {
    for (const stop of this.#working) stop();
    this.#working = [];
  }

  get working(): number {
    return this.#working.length;
  }
}

/** The app's repository in memory, as the GitHub worker would read and change it. */
export class FakeGitHub implements GitHubPort {
  readonly acts: { action: string; args: Record<string, unknown> }[] = [];
  /** Actions that fail, as GitHub failing does, and how many times each will. */
  readonly failing = new Map<ActionName, number>();
  /** Actions GitHub refuses once, with the GitHub worker's own error. */
  readonly refusing = new Map<ActionName, Error>();
  /** An action that is done, and then fails as though the line crashed before it heard back: once. */
  crashAfter: ActionName | undefined;
  /** A read that waits until the test lets it go. */
  holdReads: Promise<void> | undefined;
  readonly pulls = new Map<number, PullRequestState>();
  readonly checks = new Map<string, CheckRun[]>();
  required = ['test'];
  /** What the app's CODEOWNERS gives Martin, beside the workflows and the deployment. */
  protectedPaths = ['.github/', 'deploy/', 'Dockerfile', '**/AGENTS.md'];
  /**
   * The files the pull request changes since main, as GitHub compares them: every file a patch has changed, with the
   * hunks of each patch that changed it. GitHub's comparison is one diff from the merge base, whose hunks would merge
   * and renumber those of an earlier round; here each round's hunks keep their own lines, so a line any round showed
   * stays one a finding can be anchored to, as it is on GitHub unless a later round removed it.
   */
  diff: Comparison['files'] = [];
  #commits = 0;

  async act<K extends ActionName>(action: K, _repo: string, given: ActionArgs[K]): Promise<ActionResult<K>> {
    const args = given as Record<string, unknown>;
    const refusal = this.refusing.get(action);
    if (refusal) {
      this.refusing.delete(action);
      throw refusal;
    }
    const failures = this.failing.get(action) ?? 0;
    if (failures > 0) {
      this.failing.set(action, failures - 1);
      throw new Error(`GitHub failed: ${action} (502)`);
    }
    this.acts.push({ action, args });
    const result = this.#act(action, args) as ActionResult<K>;
    if (this.crashAfter === action) {
      this.crashAfter = undefined;
      throw new Error('The line crashed');
    }
    return result;
  }

  #act(action: ActionName, args: Record<string, unknown>): unknown {
    switch (action) {
      case 'openIssue':
        return 41;
      case 'applyPatch': {
        const sha = String(++this.#commits).padStart(40, 'f');
        for (const pr of this.pulls.values()) if (pr.head.ref === args.branch) pr.head.sha = sha;
        this.lastCommit = sha;
        for (const file of String(args.patch)
          .split(/^diff --git a\/\S+ b\//m)
          .slice(1)) {
          const path = file.slice(0, file.indexOf('\n'));
          const patch = file.slice(file.indexOf('@@'));
          const lines = patch.split('\n');
          const added = lines.filter((l) => l.startsWith('+')).length;
          const removed = lines.filter((l) => l.startsWith('-')).length;
          const before = this.diff.find((f) => f.path === path);
          if (before)
            Object.assign(before, {
              patch: `${before.patch ?? ''}\n${patch}`,
              added: before.added + added,
              removed: before.removed + removed,
            });
          else this.diff.push({ path, patch, added, removed });
        }
        return sha;
      }
      case 'openPullRequest': {
        const number = 12;
        this.pulls.set(number, {
          number,
          state: 'open',
          merged: false,
          mergeCommit: null,
          mergedBy: null,
          head: { ref: String(args.head), sha: this.lastCommit },
          base: { ref: String(args.base), sha: MAIN },
          draft: Boolean(args.draft),
          nodeId: 'PR_12',
        });
        return { number, url: 'https://github.test/pull/12', nodeId: 'PR_12' };
      }
      default:
        return undefined;
    }
  }

  lastCommit = MAIN;

  async read<K extends ReadName>(read: K, _repo: string, given: ReadArgs[K]): Promise<ReadResult<K>> {
    await this.holdReads;
    const args = given as Record<string, unknown>;
    const answer = (value: unknown) => value as ReadResult<K>;
    switch (read) {
      case 'head':
        return answer(MAIN);
      case 'requiredChecks':
        return answer(this.required);
      case 'protectedPaths':
        return answer(this.protectedPaths);
      case 'comparison':
        return answer({ mergeBase: MAIN, files: this.diff });
      case 'checkRuns':
        return answer(this.checks.get(String(args.sha)) ?? []);
      case 'pullRequest': {
        const pr = this.pulls.get(Number(args.number));
        if (!pr) throw new Error(`No pull request #${args.number}`);
        return answer(structuredClone(pr));
      }
      case 'pullRequestFrom': {
        const pr = [...this.pulls.values()].find((p) => p.head.ref === args.branch && p.state === 'open');
        return answer(pr ? structuredClone(pr) : null);
      }
    }
    throw new Error(`No fake read ${read}`);
  }

  /** The required check, finished on the pull request's head. */
  pass(number = 12, conclusion = 'success'): void {
    const pr = this.pulls.get(number);
    if (!pr) throw new Error(`No pull request #${number}`);
    this.checks.set(pr.head.sha, [
      {
        id: this.checks.size + 1,
        name: 'test',
        status: 'completed',
        conclusion,
        app: 'github-actions',
        startedAt: '2026-10-05T10:00:00Z',
        completedAt: '2026-10-05T10:01:00Z',
        title: null,
      },
    ]);
  }

  merge(number = 12): void {
    const pr = this.pulls.get(number);
    if (!pr) throw new Error(`No pull request #${number}`);
    Object.assign(pr, { state: 'closed', merged: true, mergeCommit: 'c'.repeat(40), mergedBy: 'mrogan' });
  }
}
