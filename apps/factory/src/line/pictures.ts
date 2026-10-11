/**
 * The pictures at Verify: the pages the probes worker compared while the release that carried the fix ran as a canary
 * beside the version before (`pictures/take.ts`), as a verification's "every page against the version before". A page
 * is intended when it is the ticket's own: the page its signal's screenshot was taken on, or else a page of its route.
 *
 * The screenshots go on the event as its artifacts, in a fixed order, for the sheet to show: for each page in `pages`,
 * the page on the version before and then on the canary (whose hash `pages` names); then, for each intended page with
 * a box, the page again after the rollout. The ticket's page at its signal is on its `signal.received`.
 *
 * A page is pictured with the boxes of every check that boxed something on it lately, whichever ticket they belong to.
 * Each screenshot named keeps only the boxes of the ticket's own check, and only on its own page: a ticket whose sense
 * boxes nothing (the logs, the metrics, the canary) has none on any page, nor a page after the rollout.
 */
import type { PayloadOf, Screenshot } from '@software-factory/events';
import type { Picture, Shot } from '../pictures/index.ts';

/** The most pages a verification names (`verification.finished`'s schema). */
export const MOST_PAGES = 12;

type Page = PayloadOf<'verification.finished'>['pages'][number];

/**
 * The ticket's own page: where its signal's screenshot was taken, when a sense boxed something there, with the selectors
 * of the elements its check boxed; and its route.
 */
export interface Own {
  path?: string;
  selectors?: readonly string[];
  route: string;
}

/**
 * The pages to name, at most twelve: the ticket's own first, then those that changed most, then the rest by path; and
 * their screenshots, in the order above.
 */
export function pagesFor(pictures: readonly Picture[], own: Own): { pages: Page[]; artifacts: Screenshot[] } {
  const byPath = own.path !== undefined && pictures.some((p) => p.path === own.path);
  const intended = new Set(
    pictures.filter((p) =>
      byPath ? p.path === own.path : own.route !== '*' && (p.route === own.route || p.path === own.route),
    ),
  );
  const mine = new Set(byPath ? own.selectors : []);
  // The boxes of the ticket's own check, on its own page; the selectors stay in the index. A picture taken before the
  // index kept them keeps every box on that page, as it was taken.
  const boxed = (p: Picture, { selectors, ...shot }: Shot): Screenshot => ({
    ...shot,
    boxes: !byPath || !intended.has(p) ? [] : shot.boxes.filter((_, i) => !selectors || mine.has(selectors[i] ?? '')),
  });
  const chosen = [...pictures]
    .sort(
      (a, b) =>
        Number(intended.has(b)) - Number(intended.has(a)) ||
        b.changed - a.changed ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    )
    .slice(0, MOST_PAGES);
  const rollouts = chosen.flatMap((p) => (intended.has(p) && p.rollout ? [boxed(p, p.rollout)] : []));
  return {
    pages: chosen.map((p) => ({
      page: p.path.slice(0, 60),
      route: p.route,
      screenshot: p.after.hash,
      changed: p.changed,
      intended: intended.has(p),
    })),
    artifacts: [
      ...chosen.flatMap((p) => [boxed(p, p.before), boxed(p, p.after)]),
      // A page is pictured after the rollout for any check's box: the ticket's own page only for one of its own.
      ...rollouts.filter((shot) => shot.boxes.length),
    ],
  };
}
