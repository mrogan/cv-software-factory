/**
 * Forgetting visitors' reports once they have been kept as long as they may be (`REPORT_TEXT` in policy/triage.ts).
 * Triage does it as it prunes the inbox, through the one function the store gives it for this
 * (0032_forget-reports.sql), as its role may neither change an event nor delete a report.
 */
import type { Sql } from 'postgres';

/** What a pass forgot: the events whose report text it took out, and the reports it deleted from the inbox. */
export interface Forgotten {
  texts: number;
  reports: number;
}

/**
 * Forgets every visitor's report that reached the store before `before`, in a real store. The store takes a cut
 * later than 29 days ago as 29 days ago, so no caller can make it forget a report sooner:
 *
 * - the text goes from its `signal.received`, and from each `judgement.made` Jev made of it, appended with it. The
 *   event stays, valid at its version, with the page it came from (its path, with no query: the factory's own, as its
 *   public view and its work item's title give it), and every projection reads it as one with its text withheld;
 * - its row goes from the inbox, triaged or not, with its text and the page as it was sent.
 *
 * A planner's finding is the factory's own words, and stays; so do a store's samples, whose reports are invented.
 */
export async function forgetReports(sql: Sql, before: Date): Promise<Forgotten> {
  const [forgotten] = await sql<Forgotten[]>`select texts, reports from forget_reports(${before})`;
  return forgotten ?? { texts: 0, reports: 0 };
}
