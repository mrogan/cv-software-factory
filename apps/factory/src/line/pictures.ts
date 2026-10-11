/**
 * The pictures at Verify: the pages the probes worker compared while the release that carried the fix ran as a canary
 * beside the version before (`pictures/take.ts`), as a verification's "every page against the version before". A page
 * is intended when it is the ticket's own: the page its signal's screenshot was taken on, or else a page of its route.
 *
 * The screenshots go on the event as its artifacts, in a fixed order, for the sheet to show: for each page in `pages`,
 * the page on the version before and then on the canary (whose hash `pages` names); then, for each intended page with
 * a box, the page again after the rollout. The ticket's page at its signal is on its `signal.received`.
 */
import type { PayloadOf, Screenshot } from '@software-factory/events';
import type { Picture } from '../pictures/index.ts';

/** The most pages a verification names (`verification.finished`'s schema). */
export const MOST_PAGES = 12;

type Page = PayloadOf<'verification.finished'>['pages'][number];

/** The ticket's own page: where its signal's screenshot was taken, when a sense boxed something there, and its route. */
export interface Own {
  path?: string;
  route: string;
}

/**
 * The pages to name, at most twelve: the ticket's own first, then those that changed most, then the rest by path; and
 * their screenshots, in the order above.
 */
export function pagesFor(pictures: readonly Picture[], own: Own): { pages: Page[]; artifacts: Screenshot[] } {
  const byPath = own.path !== undefined && pictures.some((p) => p.path === own.path);
  const intended = (p: Picture) =>
    byPath ? p.path === own.path : own.route !== '*' && (p.route === own.route || p.path === own.route);
  const chosen = [...pictures]
    .sort(
      (a, b) =>
        Number(intended(b)) - Number(intended(a)) ||
        b.changed - a.changed ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    )
    .slice(0, MOST_PAGES);
  return {
    pages: chosen.map((p) => ({
      page: p.path.slice(0, 60),
      route: p.route,
      screenshot: p.after.hash,
      changed: p.changed,
      intended: intended(p),
    })),
    artifacts: [
      ...chosen.flatMap((p) => [p.before, p.after]),
      ...chosen.flatMap((p) => (intended(p) && p.rollout ? [p.rollout] : [])),
    ],
  };
}
