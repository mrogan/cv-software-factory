/**
 * Browsing: from the home page to the catalogue, along the links a shopper sees, and into a department.
 */
import type { BrowserCheck } from '../senses/browser.ts';
import { exchange } from '../senses/http.ts';
import { templater } from '../senses/routes.ts';
import {
  badStatus,
  CARDS,
  fail,
  follow,
  listed,
  pageThrough,
  readCards,
  readLinks,
  type Shop,
  visit,
  walkFailure,
} from './site.ts';

export const homeLeadsToTheCatalogue: BrowserCheck<Shop> = {
  id: 'home-leads-to-the-catalogue',
  route: '/',
  async run(context) {
    const { page } = context;
    await visit(context, '/');
    const link = page.locator('nav a[href="/products"]').first();
    if (!(await link.count())) return fail('wrong-result', 'The home page has no navigation link to the catalogue.');
    const { status, evidence } = await follow(page, () => link.click());
    const bad = badStatus(status, 'The catalogue link', evidence);
    if (bad) return bad;
    if (!(await readCards(page)).length) {
      return fail('wrong-result', 'The catalogue the home page links to lists no products.', {
        evidence,
        look: [{ selector: 'main', kind: 'problem' }],
      });
    }
    return null;
  },
};

export const homeLinksOpen: BrowserCheck<Shop> = {
  id: 'home-links-open',
  route: '/',
  async run(context) {
    await visit(context, '/');
    const links = await readLinks(context.page, 'header a[href], nav a[href], main a[href], footer a[href]');
    const unique = new Map<string, string>();
    for (const { path, text } of links) if (!unique.has(path)) unique.set(path, text);
    const templateOf = templater(unique.keys());
    for (const [path, text] of [...unique].slice(0, 60)) {
      const answer = await exchange(context.app, path);
      const look = [{ selector: `a[href="${path.replaceAll('"', '')}"]`, kind: 'problem' as const }];
      // A loop is the destination's fault, not the home page's: it is filed under the route that loops, where the
      // crawler files it too, so the two are one ticket.
      if (answer.failure === 'redirect loop') {
        return fail('redirect-loop', `The link "${text || path}" to ${path} redirects round in a circle.`, {
          route: templateOf(path),
          evidence: [answer.evidence],
          look,
        });
      }
      if (answer.failure) throw new Error(`${path} did not answer`);
      const bad = badStatus(answer.status, `The link "${text || path}" to ${path}`, [answer.evidence]);
      if (bad) return { ...bad, look };
    }
    return null;
  },
};

export const departmentsListTheirProducts: BrowserCheck<Shop> = {
  id: 'departments-list-their-products',
  route: '/departments/:department',
  async run(context) {
    const { page, shared } = context;
    await visit(context, '/');
    const links = await readLinks(page, 'main a[href^="/departments/"], nav a[href^="/departments/"]');
    const departments = [...new Set(links.map(({ path }) => path))]
      .filter((path) => /^\/departments\/[^/?]+$/.test(path))
      .slice(0, 12);
    const products = await shared.products();
    for (const path of departments) {
      const department = decodeURIComponent(path.split('/')[2] ?? '');
      const { status, evidence } = await visit(context, path);
      const bad = badStatus(status, `The department page ${path}`, evidence);
      if (bad) return bad;
      const walked = await pageThrough(context);
      const failed = walkFailure(walked, `the ${department} department`);
      if (failed) return failed;
      const shown = new Set(walked.cards.map((card) => card.slug));
      const expected = products.filter((p) => p.department === department).map((p) => p.slug);
      const missing = expected.filter((slug) => !shown.has(slug));
      const extra = [...shown].filter((slug) => !expected.includes(slug));
      if (missing.length || extra.length) {
        return fail(
          'wrong-result',
          `The ${department} department lists ${shown.size} products where the shop's API has ${expected.length}${
            missing.length ? `; missing ${listed(missing)}` : ''
          }${extra.length ? `; not in the department ${listed(extra)}` : ''}.`,
          { evidence, look: [{ selector: CARDS, kind: 'problem' }] },
        );
      }
    }
    return null;
  },
};

export const browse = [homeLeadsToTheCatalogue, homeLinksOpen, departmentsListTheirProducts];
