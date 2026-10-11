/**
 * Pictures of a release, taken while both its versions run. During a canary the stable Service and the canary Service
 * answer `/version` with different commits; then the probes worker screenshots every page of the shop on each, and
 * compares each pair pixel by pixel (`compare.ts`). After full rollout the old version is gone, so the pictures cannot
 * wait for Verify, which reads them from the index (`index.ts`) as "every page against the version before".
 *
 * It is an extra pass beside the senses, not a change to what they watch: they look at the stable Service alone.
 *
 * - Once for each canary and the stable version it replaces. A canary retried after a rollback has them already.
 * - Every page the shop's front door leads to, as the traffic generator finds them, and every page a sense boxed an
 *   element on lately (`looks`), with those elements boxed on both versions: the ticket's own page, for the sheet.
 * - Either version moving while the pictures were taken (a promotion, a rollback) throws them away: a picture of the
 *   "before" might be of the after. A pass that failed is tried again, a few times.
 * - Once the canary is promoted, each page with a box is taken again on the stable Service: the page after rollout.
 */
import type { Screenshot } from '@software-factory/events';
import type { ArtifactStore } from '@software-factory/store';
import type { Check } from '../capture.ts';
import { templater } from '../senses/routes.ts';
import { compare } from './compare.ts';
import type { Look, Picture, PictureIndex } from './index.ts';

/** The most pages compared for one canary: the shop has about forty, with its departments and product pages. */
export const MOST_PAGES = 60;
/** Passes tried for one canary, or one rollout, before it is given up. */
export const TRIES = 3;

/** What a page looks like, at `app`: its PNG and its reference, with the elements boxed. */
export type Shoot = (
  app: string,
  path: string,
  shot: { route: string; version: string; elements: Check[] },
) => Promise<{ png: Uint8Array; screenshot: Screenshot }>;

export interface PicturesOptions {
  /** The stable Service and the canary Service, with no path. */
  stable: string;
  canary: string;
  /** What `/version` says at an address; rejects when it does not answer. */
  version(app: string): Promise<string>;
  /** The paths of the app's pages at an address, from its front door. */
  pages(app: string): Promise<string[]>;
  shoot: Shoot;
  index: Pick<PictureIndex, 'taken' | 'record' | 'awaitingRollout' | 'rolledOut' | 'looks'>;
  /** Where the diffs go: the screenshots are put there by `shoot`. */
  store: ArtifactStore;
  log: {
    info(fields: object, message: string): void;
    warn(fields: object, message: string): void;
  };
  now?: () => Date;
}

/** What a tick did: compared a canary's pages, took a rollout's, or nothing. */
export type Took = { compared: number } | { rolledOut: number } | null;

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
      if (!versions) return null;
      const { stable, canary } = versions;
      return stable === canary ? await this.#rollout(stable) : await this.#compare(stable, canary);
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

  /** Every page on the stable version and on the canary, compared, once for the pair. */
  async #compare(stable: string, canary: string): Promise<Took> {
    const key = `${canary} against ${stable}`;
    if (!this.#due(key)) return null;
    if (await this.#o.index.taken(canary, stable)) {
      this.#done.add(key);
      return null;
    }
    this.#tries.set(key, (this.#tries.get(key) ?? 0) + 1);
    const { log, store } = this.#o;
    const started = Date.now();
    const looks = await this.#o.index.looks(this.#now());
    const found = await this.#o.pages(this.#o.stable);
    // The pages a sense boxed come first, so a long shop never leaves them out.
    const paths = [...new Set([...looks.map((l) => l.path), ...found])].slice(0, MOST_PAGES);
    const route = routeOf(paths, looks);
    const pictures: Picture[] = [];
    for (const path of paths) {
      const shot = { route: route(path), elements: elementsOn(path, looks) };
      try {
        const before = await this.#o.shoot(this.#o.stable, path, { ...shot, version: stable });
        const after = await this.#o.shoot(this.#o.canary, path, { ...shot, version: canary });
        const { changed, diff } = compare(before.png, after.png);
        pictures.push({
          canary,
          stable,
          path,
          route: shot.route,
          before: before.screenshot,
          after: after.screenshot,
          // To a hundredth of a percent, and never to nothing when a pixel differs.
          changed: Math.ceil(changed * 10_000) / 10_000,
          diff: diff && {
            ...after.screenshot,
            hash: await store.put(diff),
            size: diff.byteLength,
            width: Math.max(before.screenshot.width, after.screenshot.width),
            height: Math.max(before.screenshot.height, after.screenshot.height),
            boxes: [],
          },
          rollout: null,
        });
      } catch (error) {
        log.warn({ path, err: describe(error) }, 'a page could not be pictured on both versions');
      }
    }
    if (!(await this.#still(stable, canary))) {
      log.warn({ stable, canary }, 'a version moved while the pictures were taken; they are dropped');
      return null;
    }
    if (!pictures.length) return null;
    await this.#o.index.record(pictures);
    this.#done.add(key);
    log.info(
      {
        stable,
        canary,
        pages: pictures.length,
        changed: pictures.filter((p) => p.changed > 0).length,
        ms: Date.now() - started,
      },
      'compared every page on the stable and the canary',
    );
    return { compared: pictures.length };
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
    const taken: Array<[Picture, Screenshot]> = [];
    for (const picture of waiting) {
      try {
        const { screenshot } = await this.#o.shoot(this.#o.stable, picture.path, {
          route: picture.route,
          version,
          elements: elementsOn(picture.path, looks),
        });
        taken.push([picture, screenshot]);
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

/** The elements the senses boxed on a page, at most four, each once. */
function elementsOn(path: string, looks: readonly Look[]): Check[] {
  const elements = new Map<string, Check>();
  for (const look of looks) {
    if (look.path !== path) continue;
    for (const element of look.elements) if (!elements.has(element.selector)) elements.set(element.selector, element);
  }
  return [...elements.values()].slice(0, 4);
}

const describe = (error: unknown) => (error instanceof Error ? error.message.split('\n')[0] : String(error));
