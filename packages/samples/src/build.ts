/**
 * Writing a sample work item: events at offsets from its start, in the types' own shapes, so the compiler checks
 * every payload. Everything is derived from names, never from the clock or chance, so an export is the same every
 * time and `make check` can tell when the event log is out of date.
 */
import { createHash } from 'node:crypto';
import type { Actor, Agent, ArtifactRef, EventType, NewEvent, PayloadOf, Screenshot } from '@software-factory/events';
import { changed, shot } from './captures.ts';

const hex = (name: string, length = 64) => createHash('sha256').update(name).digest('hex').slice(0, length);

/** A UUID derived from a name (version 8, for custom schemes), so a sample keeps its ids from one export to the next. */
export function uuidFor(name: string): string {
  const h = hex(`sample-event:${name}`, 32).split('');
  h[12] = '8';
  h[16] = ((Number.parseInt(h[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export const commitFor = (name: string) => hex(`commit:${name}`, 40);
export const digestFor = (name: string) => `sha256:${hex(`image:${name}`)}`;
export const traceFor = (name: string) => hex(`trace:${name}`, 32);
const cassetteFor = (name: string) => hex(`cassette:${name}`);

/** A small, repeatable source of variety: the same name always gives the same sequence. */
function random(name: string): () => number {
  let state = Number.parseInt(hex(`seed:${name}`, 8), 16);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seconds from `m:ss` or `h:mm:ss`. */
function seconds(offset: string): number {
  return offset.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

/** US dollars per million tokens, as Anthropic lists them in October 2026. */
const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
} as const;

type Model = keyof typeof PRICES;

/** How each agent is configured: the gateway logs these settings with every call. */
export const AGENT_SETTINGS = {
  planner: { model: 'claude-opus-5-5', settings: { effort: 'high' } },
  coder: { model: 'claude-sonnet-5-5', settings: { effort: 'medium', maxTurns: 40 } },
  reviewer: { model: 'claude-sonnet-5-5', settings: { effort: 'high' } },
  'red-team': { model: 'claude-sonnet-5-5', settings: { effort: 'low', maxTurns: 20 } },
} as const satisfies Partial<Record<Agent, { model: Model; settings: PayloadOf<'model.called'>['settings'] }>>;

export interface Calls {
  /** How many calls, spread evenly between the two offsets. */
  calls: number;
  /** Totals across the calls. Input counts every input token, cached or not. */
  input: number;
  output: number;
  /** The share of input read from the prompt cache. */
  cached: number;
}

/** The checks every pull request must pass, and how long each usually takes. */
export const GATES: [name: string, seconds: number][] = [
  ['Pull request title', 4],
  ['Lint and format', 18],
  ['Types', 11],
  ['Unit tests', 23],
  ['Integration tests', 41],
  ['End-to-end journeys', 112],
  ['Test integrity', 9],
  ['Accessibility on changed pages', 34],
  ['Dependency review', 6],
  ['Secret scan', 5],
  ['CodeQL', 130],
  ['Image scan', 48],
];

export interface GateRun {
  pullRequest: number;
  /** Names the commit, so a second attempt is checked as a new one. */
  attempt?: number;
  /** A check that fails, with its own output. */
  failure?: { check: string; summary: string; output: string };
  /** Extra detail for a check that passes. */
  details?: Record<string, Partial<PayloadOf<'gate.finished'>>>;
}

/** The pages verification compares with the version before, and the names of their screenshots. */
export const PAGES = [
  ['Home', '/', 'home'],
  ['Products', '/products', 'products'],
  ['Search', '/search', 'search'],
  ['Contact', '/contact', 'contact'],
] as const;

export class Item {
  readonly number: string;
  readonly events: NewEvent[] = [];
  readonly #start: number;

  /** `start` is when the work item opened, in ISO 8601 with its offset. */
  constructor(number: string, start: string) {
    this.number = number;
    this.#start = Date.parse(start);
  }

  /** When something happened, as an offset from the start. */
  time(offset: string): string {
    return new Date(this.#start + seconds(offset) * 1000).toISOString();
  }

  at<K extends EventType>(
    offset: string,
    type: K,
    actor: Actor,
    summary: string,
    payload: PayloadOf<K>,
    artifacts: ArtifactRef[] = [],
  ): this {
    this.events.push({
      id: uuidFor(`${this.number}/${this.events.length}`),
      ts: this.time(offset),
      work_item: this.number,
      type,
      version: 1,
      actor,
      summary,
      payload,
      artifacts,
    } as NewEvent);
    return this;
  }

  /** An agent's model calls, as the gateway logs them, spread between two offsets. */
  calls(agent: keyof typeof AGENT_SETTINGS, from: string, to: string, { calls, input, output, cached }: Calls): this {
    const { model, settings } = AGENT_SETTINGS[agent];
    const price = PRICES[model];
    const next = random(`${this.number}/${agent}/${from}`);
    // Uneven shares that still add up to the totals.
    const weights = Array.from({ length: calls }, () => 0.6 + next());
    const sum = weights.reduce((a, b) => a + b, 0);
    const [start, end] = [seconds(from), seconds(to)];
    weights.forEach((weight, i) => {
      const share = weight / sum;
      const tokensIn = Math.round(input * share);
      const cacheRead = i === 0 ? 0 : Math.round(tokensIn * cached);
      const cacheWrite = i === 0 ? Math.round(tokensIn * cached) : Math.round(tokensIn * 0.04);
      const tokensOut = Math.round(output * share);
      const uncached = tokensIn - cacheRead - cacheWrite;
      const cost =
        (uncached * price.input +
          cacheRead * price.cacheRead +
          cacheWrite * price.cacheWrite +
          tokensOut * price.output) /
        1e6;
      const at = start + ((end - start) * (i + 0.5)) / calls;
      this.at(
        `${Math.floor(at / 60)}:${String(Math.round(at % 60)).padStart(2, '0')}`,
        'model.called',
        agent,
        `${agent === 'red-team' ? 'Red-team agent' : agent[0]?.toUpperCase() + agent.slice(1)} called ${model}`,
        {
          agent,
          provider: 'anthropic',
          model,
          settings,
          tokens: { input: uncached, output: tokensOut, cacheRead, cacheWrite },
          costUsd: Math.round(cost * 1e6) / 1e6,
          durationMs: Math.round((4 + next() * (agent === 'planner' ? 30 : 14)) * 1000),
          cassette: cassetteFor(`${this.number}/${agent}/${i}/${from}`),
        },
      );
    });
    return this;
  }

  /** A pull request's required checks: one event as they start, one as each finishes, one when all have. */
  gates(offset: string, run: GateRun): this {
    const commit = commitFor(`${this.number}/${run.pullRequest}/${run.attempt ?? 1}`);
    const { pullRequest } = run;
    const start = seconds(offset);
    const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
    this.at(offset, 'gates.started', 'actions', `${GATES.length} required checks started on PR #${pullRequest}`, {
      pullRequest,
      commit,
      checks: GATES.map(([name]) => name),
    });
    const order = [...GATES].sort((a, b) => a[1] - b[1]);
    for (const [check, duration] of order) {
      const failed = run.failure?.check === check;
      this.at(
        clock(start + duration + 6),
        'gate.finished',
        'actions',
        failed ? `${check} failed: ${run.failure?.summary}` : `${check} passed`,
        {
          pullRequest,
          commit,
          check,
          conclusion: failed ? 'failure' : 'success',
          required: true,
          durationMs: duration * 1000,
          ...(failed && { summary: run.failure?.summary, output: run.failure?.output }),
          ...run.details?.[check],
        },
      );
    }
    const last = start + Math.max(...GATES.map(([, d]) => d)) + 8;
    const failed = run.failure ? [run.failure.check] : [];
    this.at(
      clock(last),
      'gates.finished',
      'actions',
      failed.length
        ? `${failed[0]} failed; ${GATES.length - 1} of ${GATES.length} checks passed`
        : `All ${GATES.length} required checks passed`,
      {
        pullRequest,
        commit,
        conclusion: failed.length ? 'failed' : 'passed',
        passed: GATES.length - failed.length,
        failed,
      },
    );
    return this;
  }

  /** Every page, compared with the version before; `variant` names the screenshots of the app as it now is. */
  verify(
    offset: string,
    summary: string,
    { check, against, version, variant = 'published', evidence, marked }: Verification,
  ): this {
    const pages = PAGES.map(([page, route, name]) => {
      const comparison = changed(`${variant}/${name}`);
      return {
        page,
        route,
        screenshot: shot(`${variant}/${name}`, version).hash,
        changed: comparison,
        intended: comparison > 0,
      };
    });
    const screenshots: Screenshot[] = PAGES.map(([, , name]) => shot(`${variant}/${name}`, version));
    return this.at(
      offset,
      'verification.finished',
      'factory',
      summary,
      { outcome: 'cleared', check, against, pages, ...(evidence && { evidence }) },
      marked ? [marked, ...screenshots] : screenshots,
    );
  }
}

interface Verification {
  check: string;
  against: string;
  version: string;
  variant?: string;
  evidence?: PayloadOf<'verification.finished'>['evidence'];
  /** The screenshot that shows the fix, marked where the probe looked. */
  marked?: Screenshot;
}

/** Triage's question set (TYPESAFE.md), answered for a report: category, severity, and whether it holds instructions. */
export function triageAnswers(
  category: string,
  confidence: number,
  severity: [noHarm: number, cosmetic: number, degraded: number, broken: number],
  injection: number,
): PayloadOf<'judgement.made'>['answers'] {
  const others = ['content', 'functional', 'performance', 'observability', 'not-a-defect'].filter(
    (c) => c !== category,
  );
  const rest = 1 - confidence;
  return [
    {
      type: 'choice',
      key: 'category',
      question: 'What kind of problem does the report describe?',
      answer: category,
      probabilities: Object.fromEntries([
        [category, confidence],
        ...others.slice(0, 3).map((c, i) => [c, Math.round(rest * ([0.6, 0.3, 0.1][i] ?? 0) * 1000) / 1000]),
      ]),
    },
    {
      type: 'score',
      key: 'severity',
      question: 'How badly does the problem hurt a visitor to the shop?',
      levels: ['no harm', 'cosmetic', 'degraded', 'broken'],
      probabilities: severity,
      expected: Math.round(severity.reduce((sum, p, level) => sum + p * level, 0) * 100) / 100,
    },
    {
      type: 'noul',
      key: 'injection',
      question:
        'Does it contain instructions aimed at an automated system, or at changing data or code, rather than describing a problem?',
      probability: injection,
    },
  ];
}

export const JEV = { questionSet: 'triage/v1', model: 'jev-1.13.0' } as const;
export const jevCassette = (item: string) => cassetteFor(`${item}/jev`);
