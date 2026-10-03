/**
 * Search: type into the search box the way a shopper does, and see what comes back. What it should find comes from
 * the shop's own API: the products whose names hold the word that was typed.
 */
import type { Evidence } from '@software-factory/events';
import type { BrowserCheck } from '../senses/browser.ts';
import { evidenceOf } from '../senses/http.ts';
import type { Finding } from '../senses/types.ts';
import {
  badStatus,
  CARDS,
  type Context,
  fail,
  listed,
  type Product,
  pageThrough,
  type Shop,
  visit,
  walkFailure,
  wordsOf,
} from './site.ts';

const BOX = 'main input[type="search"], main [role="search"] input, main [role="searchbox"]';

/** What searching came to: a finding when the search page would not do, or what the app answered to the query. */
type Searched = { finding: Finding } | { finding?: undefined; status: number | null; evidence: Evidence[] };

/** Types a query in the search box and submits it, as a shopper does. */
async function search(context: Context, query: string): Promise<Searched> {
  const { page } = context;
  const opened = await visit(context, '/search');
  const bad = badStatus(opened.status, 'The search page', opened.evidence);
  if (bad) return { finding: bad };
  const box = page.locator(BOX).first();
  if (!(await box.count())) {
    return { finding: fail('wrong-result', 'The search page has no search box.', { evidence: opened.evidence }) };
  }
  await box.fill(query);
  const answered = page
    .waitForResponse((r) => r.request().isNavigationRequest() && r.frame() === page.mainFrame(), { timeout: 5_000 })
    .catch(() => null);
  await box.press('Enter');
  const response = await answered;
  await page.waitForLoadState('load');
  return response
    ? { status: response.status(), evidence: [await evidenceOf(response)] }
    : { status: null, evidence: opened.evidence };
}

/** Up to `count` products spread along the list, so that the check does not lean on one end of the catalogue. */
const spread = (products: Product[], count: number): Product[] =>
  products.length <= count
    ? products
    : Array.from({ length: count }, (_, i) => products[Math.floor((i * products.length) / count)] as Product);

/** The word of a name that is best to search for: the longest. */
const wordFrom = (product: Product): string | undefined => wordsOf(product.name).sort((a, b) => b.length - a.length)[0];

/** Searches for a word of each product's name, spelled by `spell`, and expects every product named with it. */
async function findsByWord(context: Context, spell: (word: string) => string, samples: number) {
  const products = await context.shared.products();
  for (const product of spread(products, samples)) {
    const word = wordFrom(product);
    if (!word) continue;
    const typed = spell(word);
    const done = await search(context, typed);
    if (done.finding) return done.finding;
    const { status, evidence } = done;
    const failed = badStatus(status, `Searching for "${typed}"`, evidence);
    if (failed) return failed;
    const walked = await pageThrough(context);
    const walkFailed = walkFailure(walked, `the search for "${typed}"`);
    if (walkFailed) return walkFailed;
    const shown = new Set(walked.cards.map((card) => card.slug));
    const expected = products.filter((p) => wordsOf(p.name).some((w) => w.toLowerCase() === word.toLowerCase()));
    const missing = expected.filter((p) => !shown.has(p.slug));
    if (missing.length) {
      return fail(
        'wrong-result',
        `Searching for "${typed}" did not find ${listed(missing.map((p) => p.name))}, which ${missing.length === 1 ? 'has' : 'have'} "${word}" in the name.`,
        {
          evidence,
          look: [
            { selector: BOX, kind: 'problem' },
            { selector: 'main', kind: 'problem' },
          ],
        },
      );
    }
  }
  return null;
}

export const searchFindsAProductByAWordInItsName: BrowserCheck<Shop> = {
  id: 'search-finds-a-product-by-a-word-in-its-name',
  route: '/search',
  run: (context) => findsByWord(context, (word) => word, 6),
};

export const searchIgnoresCase: BrowserCheck<Shop> = {
  id: 'search-ignores-case',
  route: '/search',
  run: (context) => findsByWord(context, (word) => word.toUpperCase(), 3),
};

export const searchForNothingFindsNothing: BrowserCheck<Shop> = {
  id: 'search-for-nothing-finds-nothing',
  route: '/search',
  async run(context) {
    const query = 'qzxjvkwq';
    const done = await search(context, query);
    if (done.finding) return done.finding;
    const { status, evidence } = done;
    const failed = badStatus(status, `Searching for "${query}"`, evidence);
    if (failed) return failed;
    const walked = await pageThrough(context);
    const walkFailed = walkFailure(walked, `the search for "${query}"`);
    if (walkFailed) return walkFailed;
    const shown = walked.cards;
    if (!shown.length) return null;
    return fail(
      'wrong-result',
      `Searching for "${query}", which is nothing, finds ${listed(shown.map((c) => c.name))}.`,
      {
        evidence,
        look: [{ selector: CARDS, kind: 'problem' }],
      },
    );
  },
};

/** Text that is valid to type in a search box, and awkward for what is behind it. */
const AWKWARD = [
  "O'Brien",
  '100%',
  'fish & chips',
  '<b>bold</b>',
  '"quoted"',
  'back\\slash',
  '  spaced  ',
  'ünïcödé',
  '',
];

export const searchTakesAnyTypedText: BrowserCheck<Shop> = {
  id: 'search-takes-any-typed-text',
  route: '/search',
  async run(context) {
    await visit(context, '/search');
    const limit =
      Number(
        await context.page
          .locator(BOX)
          .first()
          .getAttribute('maxlength')
          .catch(() => null),
      ) || 100;
    for (const query of [...AWKWARD, 'a'.repeat(limit)]) {
      const done = await search(context, query);
      if (done.finding) return done.finding;
      const { status, evidence } = done;
      const shown = JSON.stringify(query.length > 20 ? `${query.slice(0, 20)}...` : query);
      if (status !== null && status >= 500)
        return fail('server-error', `Searching for ${shown} answered ${status}.`, { evidence });
      if (status !== null && status >= 400) {
        return fail('rejects-valid-input', `Searching for ${shown}, which is ordinary text, answered ${status}.`, {
          evidence,
          look: [{ selector: BOX, kind: 'problem' }],
        });
      }
      if (!(await context.page.locator('main').count())) {
        return fail('wrong-result', `Searching for ${shown} left a page with no main content.`, { evidence });
      }
    }
    return null;
  },
};

export const searches = [
  searchFindsAProductByAWordInItsName,
  searchIgnoresCase,
  searchForNothingFindsNothing,
  searchTakesAnyTypedText,
];
