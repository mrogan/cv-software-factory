/**
 * What a sense hands the runner. A sense checks the app and reports, for each of its checks, a pass or a finding; the
 * runner decides which findings become signals. The probes are the first sense, and the crawler is the second.
 */
import type { ArtifactRef, Evidence, SymptomClass } from '@software-factory/events';
import type { Check } from '../capture.ts';

/** A check that did not pass: what a fair observer would call it, and the proof. */
export interface Finding {
  symptom: SymptomClass;
  /** One plain sentence saying what was expected and what was seen. It goes in the log and beside the signal. */
  message: string;
  /** The route as the app names it, when it is not the check's own. */
  route?: string;
  evidence?: Evidence[];
  /** The elements on the page the check ended on to box in the screenshot: at most four. */
  look?: Check[];
}

/** Thrown from deep in a check to end it with a finding, when the check cannot go on. */
export class Found extends Error {
  readonly finding: Finding;

  constructor(finding: Finding) {
    super(finding.message);
    this.finding = finding;
  }
}

/** The result of one check in one pass. */
export interface Observation {
  /** The check's name, which is also the signal's `check`. Stable from one pass to the next. */
  check: string;
  /** What the check found, or null when it passed. */
  finding: Finding | null;
  /** The route the check looked at, as a template, or the finding's own. */
  route: string;
  /** What the check kept as proof, taken when the finding was made. Empty for a pass. */
  artifacts: ArtifactRef[];
  /** Set when the check could not tell, such as a timeout or an app that did not answer: neither a pass nor a failure. */
  trouble?: string;
}

/** One sense: something that can run all its checks against the app, and says what each found. */
export interface Sense {
  readonly name: 'probe' | 'crawler';
  /** Runs every check once against the app, which is at `version`. A check's trouble is reported, never thrown. */
  pass(version: string): Promise<Observation[]>;
}
