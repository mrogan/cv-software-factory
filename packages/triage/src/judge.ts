/**
 * What triage needs from the gateway: one request to Jev, answered. Triage depends on this interface, not on the
 * gateway, so the worker can reach it over HTTP and the evaluation set can replay cassettes in-process.
 */

/** A question as TypeSafe takes it (TYPESAFE.md). Its name is the key it is sent under. */
export type Question =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } };

export type Answer =
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence: number; probabilities: Record<string, number> }
  | { type: 'noul'; noul: number };

export interface JudgeRequest {
  agent: 'triage';
  /** The work item the spend counts against, when there is one yet. */
  workItem: string | null;
  questionSet: string;
  model: string;
  state: unknown;
  questions: Record<string, Question>;
}

export interface JudgeResult {
  model: string;
  answers: Record<string, Answer>;
  costUsd: number;
  durationMs: number;
  /** The key of the cassette that recorded or replayed it. */
  cassette: string;
}

export type Judge = (request: JudgeRequest) => Promise<JudgeResult>;

/**
 * The gateway cannot answer yet, through no fault of the signal: a spend cap is reached, or there is no key and
 * no cassette. The signal waits in the inbox, with the reason, and is tried again after `until` without using up
 * one of its attempts.
 */
export class JudgeWaiting extends Error {
  readonly until: Date;

  constructor(reason: string, until: Date) {
    super(reason);
    this.name = 'JudgeWaiting';
    this.until = until;
  }
}
