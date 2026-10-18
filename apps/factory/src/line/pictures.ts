/**
 * The pictures at Verify: the pages the probes worker compared while the release that carried the fix ran as a canary
 * beside the version before (`pictures/take.ts`), as a verification's "every page against the version before". A page
 * is intended when it is the ticket's own: the page its signal's screenshot was taken on, or else a page of its route.
 * A page that is not the ticket's own but another work item's the release carried names that work item: a release that
 * carries several changes each one's page, and the verification says whose change it was.
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
/**
 * The most boxes a screenshot on an event has (the screenshot's schema). A page is pictured with every check's boxes,
 * however many; a ticket's own check boxes at most four (the senses'), so this only keeps the event sound.
 */
export const MOST_BOXES = 4;

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

/** Another work item the release carried, and its own page as `Own` says, without the selectors. */
export interface Other {
  workItem: string;
  own: Omit<Own, 'selectors'>;
}

/** Whether the page its signal's screenshot was taken on was pictured, and the pages that are the work item's own. */
function ownPages(pictures: readonly Picture[], own: Omit<Own, 'selectors'>) {
  const byPath = own.path !== undefined && pictures.some((p) => p.path === own.path);
  const pages = new Set(
    pictures.filter((p) =>
      byPath ? p.path === own.path : own.route !== '*' && (p.route === own.route || p.path === own.route),
    ),
  );
  return { byPath, pages };
}

/**
 * The pages to name, at most twelve: the ticket's own first, then those that changed most, then any other that is
 * another's own, then the rest by path; and their screenshots, in the order above. A page that is the own of one of `others`, the other work items the release
 * carried, and not the ticket's, names the first of them.
 */
export function pagesFor(
  pictures: readonly Picture[],
  own: Own,
  others: readonly Other[] = [],
): { pages: Page[]; artifacts: Screenshot[] } {
  const { byPath, pages: intended } = ownPages(pictures, own);
  const theirs = others.map((other) => ({ workItem: other.workItem, pages: ownPages(pictures, other.own).pages }));
  const intendedFor = (p: Picture) =>
    intended.has(p) ? undefined : theirs.find((other) => other.pages.has(p))?.workItem;
  const mine = new Set(byPath ? own.selectors : []);
  // The boxes of the ticket's own check, on its own page; the selectors stay in the index. A picture taken before the
  // index kept them keeps every box on that page, as it was taken.
  const boxed = (p: Picture, { selectors, ...shot }: Shot): Screenshot => ({
    ...shot,
    boxes:
      !byPath || !intended.has(p)
        ? []
        : shot.boxes.filter((_, i) => !selectors || mine.has(selectors[i] ?? '')).slice(0, MOST_BOXES),
  });
  // The ticket's own, then those that changed or are another's own, then the rest: as the sheet orders them.
  const rank = (p: Picture) => (intended.has(p) ? 0 : p.changed > 0 || intendedFor(p) ? 1 : 2);
  const chosen = [...pictures]
    .sort((a, b) => rank(a) - rank(b) || b.changed - a.changed || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, MOST_PAGES);
  const rollouts = chosen.flatMap((p) => (intended.has(p) && p.rollout ? [boxed(p, p.rollout)] : []));
  return {
    pages: chosen.map((p) => {
      const other = intendedFor(p);
      return {
        page: p.path.slice(0, 60),
        route: p.route,
        screenshot: p.after.hash,
        changed: p.changed,
        intended: intended.has(p),
        ...(other && { intendedFor: other }),
      };
    }),
    artifacts: [
      ...chosen.flatMap((p) => [boxed(p, p.before), boxed(p, p.after)]),
      // A page is pictured after the rollout for any check's box: the ticket's own page only for one of its own.
      ...rollouts.filter((shot) => shot.boxes.length),
    ],
  };
}
