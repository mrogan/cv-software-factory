/**
 * The factory the page shows, as its server says in the page's meta tags (`apps/console/src/site.ts`): the profile
 * whose policy bounds Martin's settings, whether the gateway sends every agent to the local model (`ALL_LOCAL`),
 * whatever the settings say, and the app's address (`APP_URL`), which a flag's "Preview it" opens. Anything unexpected
 * reads as the defaults: `local`, not, and no address.
 */
import { PROFILES, type Profile } from '../../../../policy/spend.ts';

export interface Factory {
  profile: Profile;
  allLocal: boolean;
  /** The app's origin, when the server names one. */
  app: string | undefined;
}

/** The page, or as much of one as the meta tags are read from. */
interface Page {
  querySelector(selector: string): { getAttribute(name: string): string | null } | null;
}

export function factoryOf(doc: Page = (globalThis as unknown as { document: Page }).document): Factory {
  const named = doc.querySelector('meta[name="sf-profile"]')?.getAttribute('content') ?? '';
  const profile = (PROFILES as readonly string[]).includes(named) ? (named as Profile) : 'local';
  return {
    profile,
    allLocal: doc.querySelector('meta[name="sf-all-local"]')?.getAttribute('content') === 'true',
    app: appOrigin(doc.querySelector('meta[name="sf-app"]')?.getAttribute('content') ?? ''),
  };
}

/** An http or https origin, as a link may take it, or none. */
function appOrigin(given: string): string | undefined {
  try {
    const url = new URL(given);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Where "Preview it on the app" goes: the app's front page, asking for the flag's preview, which sets its cookie. */
export const previewHref = (app: string, flag: string) => `${app}/?${new URLSearchParams({ preview: flag })}`;
