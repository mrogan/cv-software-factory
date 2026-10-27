/**
 * Pictures of a release, taken while both its versions run. During a canary the stable Service and the canary Service
 * answer `/version` with different commits; then the probes worker screenshots every page of the app on each, and
 * compares each pair pixel by pixel (`compare.ts`). After full rollout the old version is gone, so the pictures cannot
 * wait for Verify, which reads them from the index (`index.ts`) as "every page against the version before".
 *
 * It is an extra pass beside the senses, not a change to what they watch: they look at the stable Service alone.
 *
 * - Once for each canary and the stable version it replaces. A canary retried after a rollback has them already.
 * - Every page the app's front door leads to, as the traffic generator finds them, and every page a sense boxed an
 *   element on lately (`looks`), with those elements boxed on both versions: the ticket's own page, for the sheet. A
 *   page may carry the boxes of more than one check; each box keeps its selector, for the line to keep a ticket's own.
 * - Either version moving while a page was taken (a promotion, a rollback) drops that page and ends the pass: its
 *   "before" might be of the after. Pages taken before stand; those missed are tried again, a few times.
 * - Once the canary is promoted, each page with a box is taken again on the stable Service: the page after rollout.
 * - Between releases, the pictures no release needs any more are deleted, once for each stable version: all but the
 *   last few releases' (`policy/release.ts`), keeping those a work item waits at Verify for and every image an event
 *   or a waiting signal names; and a flag's pictures (`probes/flag-check.ts`) no event came to name within a day.
 */
import type { Screenshot } from '@software-factory/events';
import type { ArtifactStore, DiskArtifacts } from '@software-factory/store';
import { release } from '../../../../policy/release.ts';
import type { Check } from '../capture.ts';
import { templater } from '../senses/routes.ts';
import { compare } from './compare.ts';
import type { Look, Picture, PictureIndex, Shot } from './index.ts';

/** The most pages compared for one canary: the app has about forty, with its departments and product pages. */
export const MOST_PAGES = 60;
/** Passes tried for one canary, or one rollout, before it is given up. */
export const TRIES = 3;
/**
 * How long before it is forgotten an image must have last been stored to be deleted: longer than a sense takes from a
 * screenshot to its signal in the inbox. From there to its event, triage appends the event before it marks the signal
 * taken, so one or the other always names it.
 */
const STORED_LATELY_MS = 10 * 60_000;

/** What a page looks like, at `app`: its PNG and its reference, with the elements boxed and each box's selector. */
export type Shoot = (
  app: string,
  path: string,
  shot: { route: string; version: string; elements: Check[] },
) => Promise<{ png: Uint8Array; screenshot: Screenshot; selectors: string[] }>;

export interface PicturesOptions {
  /** The stable Service and the canary Service, with no path. */
  stable: string;
  canary: string;
  /** What `/version` says at an address; rejects when it does not answer. */
  version(app: string): Promise<string>;
  /** The paths of the app's pages at an address, from its front door. */
  pages(app: string): Promise<string[]>;
  shoot: Shoot;
  index: Pick<
    PictureIndex,
    'pictured' | 'record' | 'awaitingRollout' | 'rolledOut' | 'looks' | 'forget' | 'forgetFlagPictures'
  >;
  /** Where the diffs go, and the images no release needs are deleted from: the screenshots are put there by `shoot`. */
  store: ArtifactStore & Pick<DiskArtifacts, 'remove'>;
  /** How many releases' pictures are kept, besides those Verify waits for: the policy's by default. */
  keepReleases?: number;
  log: {
    info(fields: object, message: string): void;
    warn(fields: object, message: string): void;
  };
  now?: () => Date;
}

/** What a tick did: compared a canary's pages, took a rollout's, deleted images no release needs, or nothing. */
export type Took = { compared: number } | { rolledOut: number } | { deleted: number } | null;

export class Pictures {
  readonly #o: PicturesOptions;
  /** Passes tried, by canary and stable version, or by version for a rollout. */
  readonly #tries = new Map<string, number>();
  readonly #done = new Set<string>();
  #busy = false;

  constructor(options: PicturesOptions) {
    this.#o = options;
  }

  /** Looks at both versions, and takes whatever pictures are due. Never two at once. */
  async tick(): Promise<Took> {
    if (this.#busy) return null;
    this.#busy = true;
    try {
      const versions = await this.#versions();
      if (!versions) {
        // Between releases the canary Service may not answer: what no release needs can still go.
        const stable = await this.#o.version(this.#o.stable).catch(() => null);
        return stable ? await this.#forget(stable) : null;
      }
      const { stable, canary } = versions;
      if (stable !== canary) return await this.#compare(stable, canary);
      return (await this.#rollout(stable)) ?? (await this.#forget(stable));
    } catch (error) {
      this.#o.log.warn({ err: describe(error) }, 'the pictures could not be taken');
      return null;
    } finally {
      this.#busy = false;
    }
  }

  async #versions(): Promise<{ stable: string; canary: string } | null> {
    const { stable, canary, version } = this.#o;
    try {
      const [s, c] = await Promise.all([version(stable), version(canary)]);
      return { stable: s, canary: c };
    } catch {
      // Between releases the canary Service may have no pods to answer, and in a release's first moments neither may.
      return null;
    }
  }

  /**
   * Every page on the stable version and on the canary, compared, once for the pair. Each page is recorded as soon as
   * both versions are seen not to have moved since before it was taken, so a canary promoted halfway keeps the pages
   * taken before; a pass that missed some tries those again.
   */
  async #compare(stable: string, canary: string): Promise<Took> {
    const key = `${canary} against ${stable}`;
    if (!this.#due(key)) return null;
    const { log, store, index } = this.#o;
    const looks = await index.looks(this.#now());
    const found = await this.#o.pages(this.#o.stable);
    // The pages a sense boxed come first, so the rest never crowd them out, and a short canary takes them first.
    const paths = [...new Set([...looks.map((l) => l.path), ...found])].slice(0, MOST_PAGES);
    if (!paths.length) {
      // The front door did not answer: no page is known, which is not the same as every page pictured.
      this.#tries.set(key, (this.#tries.get(key) ?? 0) + 1);
      log.warn({ stable, canary }, 'no pages were found to picture; trying again');
      return null;
    }
    const already = await index.pictured(canary, stable);
    const missing = paths.filter((path) => !already.has(path));
    if (!missing.length) {
      this.#done.add(key);
      return null;
    }
    this.#tries.set(key, (this.#tries.get(key) ?? 0) + 1);
    const started = Date.now();
    const route = routeOf(paths, looks);
    let recorded = 0;
    let changed = 0;
    for (const path of missing) {
      const shot = { route: route(path), elements: elementsOn(path, looks) };
      let picture: Picture;
      try {
        const before = await this.#o.shoot(this.#o.stable, path, { ...shot, version: stable });
        const after = await this.#o.shoot(this.#o.canary, path, { ...shot, version: canary });
        const comparison = compare(before.png, after.png);
        picture = {
          canary,
          stable,
          path,
          route: shot.route,
          before: { ...before.screenshot, selectors: before.selectors },
          after: { ...after.screenshot, selectors: after.selectors },
          // To a hundredth of a percent, and never to nothing when a pixel differs.
          changed: Math.ceil(comparison.changed * 10_000) / 10_000,
          diff: comparison.diff && {
            ...after.screenshot,
            hash: await store.put(comparison.diff),
            size: comparison.diff.byteLength,
            width: Math.max(before.screenshot.width, after.screenshot.width),
            height: Math.max(before.screenshot.height, after.screenshot.height),
            boxes: [],
          },
          rollout: null,
        };
      } catch (error) {
        log.warn({ path, err: describe(error) }, 'a page could not be pictured on both versions');
        continue;
      }
      // Either version moving (a promotion, a rollback) may have come between the two pictures: this one is dropped,
      // and those recorded before it stand.
      if (!(await this.#still(stable, canary))) {
        log.warn({ stable, canary, path }, 'a version moved while the pictures were taken; the rest are dropped');
        break;
      }
      await index.record([picture]);
      recorded++;
      if (picture.changed > 0) changed++;
    }
    if (recorded === missing.length) this.#done.add(key);
    if (!recorded) return null;
    log.info(
      { stable, canary, pages: recorded, changed, ms: Date.now() - started },
      'compared pages on the stable and the canary',
    );
    return { compared: recorded };
  }

  /** The pages with a box, taken again once the canary they were pictured on is the stable version. */
  async #rollout(version: string): Promise<Took> {
    const key = `rollout of ${version}`;
    if (!this.#due(key)) return null;
    const waiting = await this.#o.index.awaitingRollout(version);
    if (!waiting.length) {
      this.#done.add(key);
      return null;
    }
    this.#tries.set(key, (this.#tries.get(key) ?? 0) + 1);
    const looks = await this.#o.index.looks(this.#now());
    const taken: Array<[Picture, Shot]> = [];
    for (const picture of waiting) {
      try {
        const { screenshot, selectors } = await this.#o.shoot(this.#o.stable, picture.path, {
          route: picture.route,
          version,
          elements: elementsOn(picture.path, looks),
        });
        taken.push([picture, { ...screenshot, selectors }]);
      } catch (error) {
        this.#o.log.warn({ path: picture.path, err: describe(error) }, 'a page could not be pictured after rollout');
      }
    }
    const now = await this.#o.version(this.#o.stable).catch(() => null);
    if (now !== version) return null;
    for (const [picture, screenshot] of taken) await this.#o.index.rolledOut(picture, screenshot);
    if (taken.length === waiting.length) this.#done.add(key);
    return { rolledOut: taken.length };
  }

  /**
   * Between releases, once the pages after the rollout are taken, the pictures no release needs any more are forgotten
   * and their images deleted: once for each stable version, and once when the worker starts. An image stored again in
   * the last few minutes stays, as a signal or event may be about to name it (`DiskArtifacts.remove`).
   */
  async #forget(version: string): Promise<Took> {
    const key = `forget at ${version}`;
    if (!this.#due(key)) return null;
    this.#tries.set(key, (this.#tries.get(key) ?? 0) + 1);
    const unusedSince = new Date(this.#now().getTime() - STORED_LATELY_MS);
    const remove = (hash: string) => this.#o.store.remove(hash, unusedSince);
    const deleted =
      (await this.#o.index.forget(this.#o.keepReleases ?? release.pictures.keepReleases, version, remove)) +
      (await this.#o.index.forgetFlagPictures(this.#now(), remove));
    this.#done.add(key);
    if (!deleted) return null;
    this.#o.log.info({ version, images: deleted }, 'deleted the pictures no release needs');
    return { deleted };
  }

  #due(key: string): boolean {
    return !this.#done.has(key) && (this.#tries.get(key) ?? 0) < TRIES;
  }

  async #still(stable: string, canary: string): Promise<boolean> {
    const now = await this.#versions();
    return now?.stable === stable && now.canary === canary;
  }

  #now(): Date {
    return this.#o.now?.() ?? new Date();
  }

  /** Polls every `pollMs` until the returned function is called. The first is at once. */
  start(pollMs = 15_000): () => Promise<void> {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let current: Promise<unknown> = Promise.resolve();
    const poll = () => {
      current = this.tick().finally(() => {
        if (!stopped) timer = setTimeout(poll, pollMs);
      });
    };
    poll();
    return async () => {
      stopped = true;
      clearTimeout(timer);
      await current;
    };
  }
}

/** The route of each path: as the sense that boxed something on it named it, or worked out from all the paths. */
function routeOf(paths: readonly string[], looks: readonly Look[]): (path: string) => string {
  const template = templater(paths);
  const named = new Map(looks.filter((l) => l.route.startsWith('/')).map((l) => [l.path, l.route]));
  return (path) => named.get(path) ?? template(path);
}

/**
 * The elements the senses boxed on a page, each once, however many: the line keeps only a ticket's own, so none is cut
 * here for another's.
 */
function elementsOn(path: string, looks: readonly Look[]): Check[] {
  const elements = new Map<string, Check>();
  for (const look of looks) {
    if (look.path !== path) continue;
    for (const element of look.elements) if (!elements.has(element.selector)) elements.set(element.selector, element);
  }
  return [...elements.values()];
}

const describe = (error: unknown) => (error instanceof Error ? error.message.split('\n')[0] : String(error));
