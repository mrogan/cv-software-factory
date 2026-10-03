/**
 * Judging a visitor's report: the one thing triage asks a model about. Jev answers `triage/v1` about the report
 * (scrubbed), routing code decides where it goes, and a content report gets a second request, `passage/v1`, which
 * chooses the passage of the page it is about from the page as the factory read it itself. The ticket then holds
 * the factory's own text, never the visitor's.
 */
import {
  type PayloadOf,
  REPORT_CATEGORIES,
  type ReportCategory,
  type Screenshot,
  SYMPTOM_CLASSES,
  type SymptomClass,
} from '@software-factory/events';
import type { Answer, Judge, JudgeResult, Question } from './judge.ts';
import {
  type Candidate,
  candidateKey,
  MODEL,
  NONE,
  PASSAGE,
  passageKey,
  passageQuestions,
  type ReportState,
  SEVERITY_LEVELS,
  TRIAGE,
  triageQuestions,
} from './questions.ts';
import { type Routed, routeReport } from './routing.ts';
import { privatePath, scrub } from './scrub.ts';

/** The page a report names, as the factory sees it: a screenshot at its path, and its text in passages. */
export interface PageView {
  screenshot: Screenshot;
  passages: string[];
}

/** Reads a page of the app at a path, with no query: that is the visitor's. Null when it cannot be read. */
export type PageReader = (path: string) => Promise<PageView | null>;

export type Judgement = PayloadOf<'judgement.made'>;
export type Fingerprint = PayloadOf<'ticket.opened'>['fingerprint'];

export interface ReportDecision {
  routed: Routed;
  /** One per request to Jev, in order. */
  judgements: Judgement[];
  /** For a ticket: what it is matched by. A content ticket's passage is the factory's text from the page. */
  fingerprint?: Fingerprint;
  screenshot?: Screenshot;
  /** The scrubbed text, as Jev read it. The only form of the report triage keeps. */
  text: string;
}

export interface Report {
  page: string;
  text: string;
  /** The route the page belongs to, as the app names it. */
  route: string;
}

export async function judgeReport(
  report: Report,
  candidates: readonly Candidate[],
  judge: Judge,
  read: PageReader,
): Promise<ReportDecision> {
  const path = privatePath(report.page);
  const state: ReportState = { page: path, report: scrub(report.text) };
  const view = await read(path);

  const questions = triageQuestions(candidates);
  const result = await judge({ agent: 'triage', workItem: null, questionSet: TRIAGE, model: MODEL, state, questions });
  const repeat = result.answers.repeat;
  const routed = routeReport({
    category: label(result, 'category', REPORT_CATEGORIES) as ReportCategory,
    symptom: label(result, 'symptom', SYMPTOM_CLASSES) as SymptomClass,
    severity: answer(result, 'severity', 'score').score,
    injection: answer(result, 'injection', 'noul').noul,
    repeat:
      repeat?.type === 'choice'
        ? {
            workItem: candidates.find((_, i) => candidateKey(i) === repeat.choice)?.workItem ?? null,
            probability: repeat.probabilities[repeat.choice] ?? 0,
          }
        : undefined,
  });

  const judgements: Judgement[] = [
    {
      ...recorded(result, TRIAGE, state, questions),
      ...(candidates.length > 0 && { state: { ...stateOf(state), candidates: candidates.map(offered) } }),
      route: routed.route,
      ...(routed.route === 'repeat' && { joined: routed.joined }),
    },
  ];
  const decision: ReportDecision = {
    routed,
    judgements,
    text: state.report,
    ...(view && { screenshot: view.screenshot }),
  };
  if (routed.route !== 'ticket') return decision;

  decision.fingerprint = { route: privatePath(report.route), class: routed.symptom };
  const passages = passagesOf(view?.passages ?? []);
  if (routed.category === 'content' && passages.length) {
    const asked = passageQuestions(passages);
    const chosen = await judge({
      agent: 'triage',
      workItem: null,
      questionSet: PASSAGE,
      model: MODEL,
      state,
      questions: asked,
    });
    judgements.push({
      ...recorded(chosen, PASSAGE, state, asked),
      state: { ...stateOf(state), passages: passages.map((text, i) => ({ key: passageKey(i), text })) },
    });
    const pick = answer(chosen, 'passage', 'choice').choice;
    const passage = passages.find((_, i) => passageKey(i) === pick);
    if (pick !== NONE && passage) decision.fingerprint = { page: path, text: passage };
  }
  return decision;
}

const stateOf = (state: ReportState): Judgement['state'] => ({ report: { page: state.page, text: state.report } });

const offered = (ticket: Candidate, i: number) => ({
  key: candidateKey(i),
  workItem: ticket.workItem,
  title: ticket.title,
  category: ticket.category,
  ...(ticket.symptom && { symptom: ticket.symptom }),
});

/** A request and its answers, as `judgement.made` records them. */
function recorded(
  result: JudgeResult,
  questionSet: string,
  state: ReportState,
  questions: Record<string, Question>,
): Judgement {
  return {
    questionSet,
    model: result.model,
    state: stateOf(state),
    answers: Object.entries(questions).map(([key, question]) => answerOf(key, question, result.answers[key])),
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    cassette: result.cassette,
  };
}

function answerOf(key: string, question: Question, given: Answer | undefined): Judgement['answers'][number] {
  if (!given || given.type !== question.type) throw new Error(`Jev gave no ${question.type} answer to ${key}`);
  const base = { key, question: question.instructions };
  if (given.type === 'choice')
    return { type: 'choice', ...base, answer: given.choice, probabilities: given.probabilities };
  if (given.type === 'score') {
    const levels = key === 'severity' ? [...SEVERITY_LEVELS] : (question.criteria as string[]).map((_, i) => `${i}`);
    return {
      type: 'score',
      ...base,
      levels,
      probabilities: levels.map((_, i) => given.probabilities[String(i)] ?? 0),
      expected: given.score,
    };
  }
  return { type: 'noul', ...base, probability: given.noul };
}

function answer<T extends Answer['type']>(result: JudgeResult, key: string, type: T): Extract<Answer, { type: T }> {
  const given = result.answers[key];
  if (given?.type !== type) throw new Error(`Jev gave no ${type} answer to ${key}`);
  return given as Extract<Answer, { type: T }>;
}

function label(result: JudgeResult, key: string, labels: readonly string[]): string {
  const { choice } = answer(result, key, 'choice');
  if (!labels.includes(choice)) throw new Error(`Jev answered ${key} with a label it was not offered`);
  return choice;
}

/**
 * Passages as a question may offer them and an event may keep them: whitespace folded, none empty or repeated, each
 * at most 200 characters (a longer one keeps its start), and at most 40.
 */
export function passagesOf(read: readonly string[]): string[] {
  const passages = read
    .map((passage) => passage.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((passage) => (passage.length <= 200 ? passage : `${passage.slice(0, 199)}…`));
  return [...new Set(passages)].slice(0, 40);
}
