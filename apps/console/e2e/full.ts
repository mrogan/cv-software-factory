/**
 * The full events, as the admin service streams them to Martin's session, made from the samples for the browser tests:
 * the samples are public views, so each visitor's report is given back the text a visitor wrote. Everything else in
 * them is the same in both.
 */
import type { RawEvent } from '@software-factory/events';

/** What the samples' visitor wrote, with a link, an address and markup, which the console leaves out. */
export const REPORT_TEXT =
  'The contact form ate my message twice, so I gave up. <b>Mail me</b> at someone@example.com or see https://example.com/help';

/** The same, as Martin reads it on the sheet. */
export const REPORT_SHOWN = 'The contact form ate my message twice, so I gave up. bMail me/b at or see';

/** An event as its full version carries it: a report with its text. */
export function full<T extends RawEvent>(event: T): T {
  const payload = event.payload as { report?: { page: string }; state?: { report?: { page: string } } };
  if (event.type === 'signal.received' && payload.report) {
    return { ...event, payload: { ...payload, report: { ...payload.report, text: REPORT_TEXT } } };
  }
  if (event.type === 'judgement.made' && payload.state?.report) {
    const state = { ...payload.state, report: { ...payload.state.report, text: REPORT_TEXT } };
    return { ...event, payload: { ...payload, state } };
  }
  return event;
}
