/**
 * A product's own page: every product the shop's API lists has one, and it says what the API says.
 */
import type { BrowserCheck } from '../senses/browser.ts';
import { badStatus, fail, firstPrice, mainText, priceOf, type Shop, showing, visit } from './site.ts';

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

export const productPageAgreesWithTheApi: BrowserCheck<Shop> = {
  id: 'product-page-agrees-with-the-api',
  route: '/products/:slug',
  async run(context) {
    const { page, shared } = context;
    for (const product of await shared.products()) {
      const path = `/products/${encodeURIComponent(product.slug)}`;
      const { status, evidence } = await visit(context, path);
      const bad = badStatus(status, `The page of ${product.name}, ${path},`, evidence);
      if (bad) return bad;
      const heading = squash(
        await page
          .locator('main h1')
          .first()
          .innerText({ timeout: 3_000 })
          .catch(() => ''),
      );
      if (heading !== product.name) {
        return fail(
          'wrong-result',
          `${path} is headed "${heading}", where the shop's API calls the product "${product.name}".`,
          {
            evidence,
            look: [{ selector: 'main h1', kind: 'problem' }],
          },
        );
      }
      const price = firstPrice(await mainText(page));
      if (price !== priceOf(product)) {
        return fail(
          'wrong-result',
          `${product.name} is priced at ${price ?? 'nothing'} on its page, where the shop's API says ${priceOf(product)}.`,
          { evidence, look: [{ selector: price ? showing(price) : 'main h1', kind: 'problem' }] },
        );
      }
    }
    return null;
  },
};

export const product = [productPageAgreesWithTheApi];
