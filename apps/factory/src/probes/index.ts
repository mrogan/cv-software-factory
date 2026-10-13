/**
 * The probes: the journeys a shopper takes through a shop, each made of checks that any shop should pass. They are
 * written from the app's public pages alone, as a shopper sees them, and compare what the pages say with what the
 * app's own API says. No check knows a product, a page's wording or a defect by name.
 *
 * Every request they make, from the browser and without it, carries `UNMEASURED`: a probe is not a visit, and must not
 * weigh on the figures a canary or its baseline is judged on.
 */
import type { ArtifactStore } from '@software-factory/store';
import { type BrowserCheck, BrowserSense } from '../senses/browser.ts';
import { UNMEASURED } from '../senses/http.ts';
import { browse } from './browse.ts';
import { catalogue } from './catalogue.ts';
import { contact } from './contact.ts';
import { product } from './product.ts';
import { searches } from './search.ts';
import { Shop } from './site.ts';

/** In the order a shopper meets them. */
export const PROBES: readonly BrowserCheck<Shop>[] = [...browse, ...catalogue, ...product, ...searches, ...contact];

export interface ProbeOptions {
  app: string;
  store: ArtifactStore;
  log: { warn(fields: object, message: string): void };
}

export const probes = ({ app, store, log }: ProbeOptions): BrowserSense<Shop> =>
  new BrowserSense({
    name: 'probe',
    app,
    checks: PROBES,
    store,
    log,
    shared: () => new Shop(app, UNMEASURED),
    headers: UNMEASURED,
  });
