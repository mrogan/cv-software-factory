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
  /** Whether to say what each probe's pages left on the device and which other origins they asked: the gates'. */
  device?: boolean;
  /**
   * A flag to ask the app to preview, as the console's "Preview it" link does, before the probes run: Verify's check
   * of a flag at its opt-in stage. Every probe after it then runs with the preview cookie, which the `/device` check
   * allows.
   */
  preview?: string | undefined;
}

/** The check that asks for a preview: its id, and the checks the watch makes of its page, which say nothing of a flag. */
export const PREVIEW_CHECK = 'preview';

/** Asks the app to preview a flag on its front page, and finds nothing itself: the probes after it look. */
export const previewCheck = (flag: string): BrowserCheck<Shop> => ({
  id: PREVIEW_CHECK,
  route: '/',
  run: async ({ preview }) => {
    await preview(flag, '/');
    return null;
  },
});

export const probes = ({ app, store, log, device = false, preview }: ProbeOptions): BrowserSense<Shop> =>
  new BrowserSense({
    name: 'probe',
    app,
    checks: preview ? [previewCheck(preview), ...PROBES] : PROBES,
    store,
    log,
    shared: () => new Shop(app, UNMEASURED),
    headers: UNMEASURED,
    device,
  });
