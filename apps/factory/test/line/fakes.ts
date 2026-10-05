/**
 * Stand-ins for the line's two collaborators beyond the store: the runners, which hand back what each test's agents
 * say and write their calls to `model_calls` as the gateway would; and the GitHub worker, a repository in memory with
 * pull requests, check runs and issues.
 */
import type { Sql } from 'postgres';
import type { Handback } from '../../../runner/src/step.ts';
import type { CheckRun, PullRequestState, Reads } from '../../src/github/reads.ts';
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
  readonly #agents: Partial<Record<string, Agent>>;
  readonly #sql: Sql;
  #working: (() => void)[] = [];

  constructor(sql: Sql, agents: Partial<Record<string, Agent>>) {
    this.#sql = sql;
    this.#agents = agents;
  }

  async run(request: StepRequest): Promise<StepOutcome> {
    this.requests.push(request);
    const job = jobName(request.agent, request.workItem, request.round, request.attempt);
    const agent = this.#agents[request.agent];
    if (!agent) throw new Error(`No fake ${request.agent}`);
    const answer = await agent(request);
    if (answer === 'works on') {
      await new Promise<void>((resolve) => this.#working.push(resolve));
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
  readonly pulls = new Map<number, PullRequestState>();
  readonly checks = new Map<string, CheckRun[]>();
  required = ['test'];
  #commits = 0;

  async act<T>(action: string, _repo: string, args: Record<string, unknown>): Promise<T> {
    this.acts.push({ action, args });
    switch (action) {
      case 'openIssue':
        return 41 as T;
      case 'applyPatch': {
        const sha = String(++this.#commits).padStart(40, 'f');
        for (const pr of this.pulls.values()) if (pr.head.ref === args.branch) pr.head.sha = sha;
        this.lastCommit = sha;
        return sha as T;
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
          draft: Boolean(args.draft),
          nodeId: 'PR_12',
        });
        return { number, url: 'https://github.test/pull/12', nodeId: 'PR_12' } as T;
      }
      default:
        return null as T;
    }
  }

  lastCommit = MAIN;

  async read<K extends keyof Reads>(
    read: K,
    _repo: string,
    args: Record<string, unknown>,
  ): Promise<Awaited<ReturnType<Reads[K]>>> {
    const answer = (value: unknown) => value as Awaited<ReturnType<Reads[K]>>;
    switch (read) {
      case 'head':
        return answer(MAIN);
      case 'requiredChecks':
        return answer(this.required);
      case 'checkRuns':
        return answer(this.checks.get(String(args.sha)) ?? []);
      case 'pullRequest': {
        const pr = this.pulls.get(Number(args.number));
        if (!pr) throw new Error(`No pull request #${args.number}`);
        return answer(structuredClone(pr));
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
