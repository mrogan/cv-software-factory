/**
 * The catalogue: the list of everything the shop sells, and the pages and filters a shopper uses to get through it.
 * What it should hold is whatever the shop's own API says it sells.
 */
import type { BrowserCheck } from '../senses/browser.ts';
import {
  badStatus,
  CARDS,
  fail,
  listed,
  pageThrough,
  priceOf,
  readLinks,
  type Shop,
  visit,
  walkFailure,
} from './site.ts';

export const catalogueAgreesWithTheApi: BrowserCheck<Shop> = {
  id: 'catalogue-agrees-with-the-api',
  route: '/products',
  async run(context) {
    const products = new Map((await context.shared.products()).map((p) => [p.slug, p]));
    const { status, evidence } = await visit(context, '/products');
    const bad = badStatus(status, 'The catalogue', evidence);
    if (bad) return bad;
    const walked = await pageThrough(context);
    for (const card of walked.cards) {
      const product = products.get(card.slug);
      if (!product) continue;
      if (card.name !== product.name) {
        return fail(
          'wrong-result',
          `The catalogue calls ${card.slug} "${card.name}", where the shop's API says "${product.name}".`,
          {
            evidence,
            look: [{ selector: CARDS, kind: 'problem' }],
          },
        );
      }
      if (card.price !== priceOf(product)) {
        return fail(
          'wrong-result',
          `The catalogue prices ${product.name} at ${card.price ?? 'nothing'}, where the shop's API says ${priceOf(product)}.`,
          { evidence, look: [{ selector: CARDS, kind: 'problem' }] },
        );
      }
    }
    return null;
  },
};

export const cataloguePagesCoverTheRange: BrowserCheck<Shop> = {
  id: 'catalogue-pages-cover-the-range',
  route: '/products',
  async run(context) {
    const products = await context.shared.products();
    const { status, evidence } = await visit(context, '/products');
    const bad = badStatus(status, 'The catalogue', evidence);
    if (bad) return bad;
    const walked = await pageThrough(context);
    const failed = walkFailure(walked, 'the catalogue');
    if (failed) return failed;
    const counts = new Map<string, number>();
    for (const { slug } of walked.cards) counts.set(slug, (counts.get(slug) ?? 0) + 1);
    const known = new Set(products.map((p) => p.slug));
    const missing = products.filter((p) => !counts.has(p.slug)).map((p) => p.name);
    const repeated = [...counts].filter(([, n]) => n > 1).map(([slug]) => slug);
    const unknown = [...counts.keys()].filter((slug) => !known.has(slug));
    if (!missing.length && !repeated.length && !unknown.length) return null;
    const problems = [
      missing.length && `missing ${listed(missing)}`,
      repeated.length && `repeats ${listed(repeated)}`,
      unknown.length && `lists ${listed(unknown)}, which the API does not`,
    ].filter(Boolean);
    return fail(
      'wrong-result',
      `Paging through the catalogue shows ${counts.size} of the ${products.length} products the API lists, over ${walked.pages} pages: ${problems.join('; ')}.`,
      { evidence, look: [{ selector: CARDS, kind: 'problem' }] },
    );
  },
};

export const catalogueFiltersByDepartment: BrowserCheck<Shop> = {
  id: 'catalogue-filters-by-department',
  route: '/products',
  async run(context) {
    const products = await context.shared.products();
    await visit(context, '/products');
    const filters = [
      ...new Set((await readLinks(context.page, 'main a[href*="department="]')).map(({ path }) => path)),
    ].slice(0, 12);
    for (const path of filters) {
      const department = new URL(path, context.app).searchParams.get('department') ?? '';
      const { status, evidence } = await visit(context, path);
      const bad = badStatus(status, `The filter ${path}`, evidence);
      if (bad) return bad;
      const walked = await pageThrough(context);
      const failed = walkFailure(walked, `the ${department} filter`);
      if (failed) return failed;
      const shown = new Set(walked.cards.map((card) => card.slug));
      const expected = products.filter((p) => p.department === department).map((p) => p.slug);
      const missing = expected.filter((slug) => !shown.has(slug));
      const extra = [...shown].filter((slug) => !expected.includes(slug));
      if (missing.length || extra.length) {
        return fail(
          'wrong-result',
          `Filtering by ${department} shows ${shown.size} products where the shop's API has ${expected.length}${
            missing.length ? `; missing ${listed(missing)}` : ''
          }${extra.length ? `; from other departments ${listed(extra)}` : ''}.`,
          { evidence, look: [{ selector: CARDS, kind: 'problem' }] },
        );
      }
    }
    return null;
  },
};

export const catalogue = [catalogueAgreesWithTheApi, cataloguePagesCoverTheRange, catalogueFiltersByDepartment];
