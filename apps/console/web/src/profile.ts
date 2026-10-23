/**
 * The factory the page shows, as its server says in the page's meta tags (`apps/console/src/site.ts`): the profile
 * whose policy bounds Martin's settings, and whether the gateway sends every agent to the local model (`ALL_LOCAL`),
 * whatever the settings say. Anything unexpected reads as the defaults: `local`, and not.
 */
import { PROFILES, type Profile } from '../../../../policy/spend.ts';

export interface Factory {
  profile: Profile;
  allLocal: boolean;
}

/** The page, or as much of one as the meta tags are read from. */
interface Page {
  querySelector(selector: string): { getAttribute(name: string): string | null } | null;
}

export function factoryOf(doc: Page = (globalThis as unknown as { document: Page }).document): Factory {
  const named = doc.querySelector('meta[name="sf-profile"]')?.getAttribute('content') ?? '';
  const profile = (PROFILES as readonly string[]).includes(named) ? (named as Profile) : 'local';
  return { profile, allLocal: doc.querySelector('meta[name="sf-all-local"]')?.getAttribute('content') === 'true' };
}
