/**
 * The index of a release's pictures (migration 0010): which pages were compared for which canary, with their
 * screenshots' references, and where each sense last boxed an element. The images themselves are in the artifact
 * store, which the probes worker writes; the line has no way to that store, and reads this instead.
 */

import type { Readable } from 'node:stream';
import type { Screenshot } from '@software-factory/events';
import type { ArtifactStore } from '@software-factory/store';
import type { Sql } from 'postgres';
import type { Check } from '../capture.ts';

/**
 * A screenshot as the index keeps it: the reference an event carries, with the selector of the element each of its
 * boxes was drawn round, in the order of the boxes. A page carries the boxes of every sense that boxed something on it,
 * and the selectors are how the line keeps only a ticket's own (`line/pictures.ts`); no event carries them. A picture
 * taken before they were kept has none.
 */
export type Shot = Screenshot & { selectors?: string[] };

/** One page compared: on the stable version (before) and on the canary (after). */
export interface Picture {
  canary: string;
  stable: string;
  path: string;
  route: string;
  before: Shot;
  after: Shot;
  /** The share of pixels that differ. */
  changed: number;
  /** Where they differ, or null when nothing does. */
  diff: Screenshot | null;
  /** The page on the stable Service after the canary was promoted, with the boxes; only for a page with any. */
  rollout: Shot | null;
}

/** Where a sense's signal was seen: the page its screenshot was taken on, and the elements it boxed there. */
export interface Look {
  sense: 'probe' | 'crawler';
  check: string;
  route: string;
  path: string;
  elements: Check[];
}

/** How long a look is boxed on the pictures after it was last seen: a defect that long gone has been dealt with. */
const LOOKS_FOR_DAYS = 30;

interface PictureRow {
  canary: string;
  stable: string;
  path: string;
  route: string;
  before: Shot;
  after: Shot;
  changed: number;
  diff: Screenshot | null;
  rollout: Shot | null;
}

export class PictureIndex {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  /** The paths of a canary's pages compared with the stable version already. */
  async pictured(canary: string, stable: string): Promise<Set<string>> {
    const rows = await this.#sql<{ path: string }[]>`
      select path from pictures where canary = ${canary} and stable = ${stable}`;
    return new Set(rows.map((r) => r.path));
  }

  /** Records a canary's pictures, all or none. A page already recorded keeps what it has. */
  async record(pictures: readonly Picture[]): Promise<void> {
    if (!pictures.length) return;
    const sql = this.#sql;
    await sql.begin(async (tx) => {
      for (const p of pictures) {
        await tx`
          insert into pictures (canary, stable, path, route, before, after, changed, diff)
          values (${p.canary}, ${p.stable}, ${p.path}, ${p.route}, ${tx.json(p.before as never)},
                  ${tx.json(p.after as never)}, ${p.changed}, ${p.diff ? tx.json(p.diff as never) : null})
          on conflict do nothing`;
      }
    });
  }

  /** A canary's pictures against the stable version, in the order of their paths. */
  async of(canary: string, stable: string): Promise<Picture[]> {
    return this.#sql<PictureRow[]>`
      select canary, stable, path, route, before, after, changed, diff, rollout from pictures
      where canary = ${canary} and stable = ${stable} order by path`;
  }

  /** The pages of a version, pictured as a canary, still to be taken after its rollout: those with a box. */
  async awaitingRollout(version: string): Promise<Picture[]> {
    return this.#sql<PictureRow[]>`
      select canary, stable, path, route, before, after, changed, diff, rollout from pictures
      where canary = ${version} and rollout is null and jsonb_array_length(after->'boxes') > 0
      order by path`;
  }

  /** Records a page after the rollout, once. */
  async rolledOut(picture: Pick<Picture, 'canary' | 'stable' | 'path'>, shot: Shot): Promise<void> {
    await this.#sql`
      update pictures set rollout = ${this.#sql.json(shot as never)}
      where canary = ${picture.canary} and stable = ${picture.stable} and path = ${picture.path} and rollout is null`;
  }

  /** Remembers where a sense boxed what it found, in place of where it last did for the same check. */
  async remember(look: Look, at: Date): Promise<void> {
    await this.#sql`
      insert into looks (sense, "check", route, path, elements, seen_at)
      values (${look.sense}, ${look.check}, ${look.route}, ${look.path}, ${this.#sql.json(look.elements as never)},
              ${at})
      on conflict (sense, "check", route)
      do update set path = excluded.path, elements = excluded.elements, seen_at = excluded.seen_at`;
  }

  /** The looks seen lately, to box on the pictures. */
  async looks(now: Date): Promise<Look[]> {
    const since = new Date(now.getTime() - LOOKS_FOR_DAYS * 24 * 60 * 60_000);
    return this.#sql<Look[]>`
      select sense, "check" as check, route, path, elements from looks where seen_at >= ${since}
      order by seen_at desc`;
  }

  /** Where a signal's own check last boxed what it found. */
  async lookOf(sense: string, check: string, route: string): Promise<Look | undefined> {
    const [look] = await this.#sql<Look[]>`
      select sense, "check" as check, route, path, elements from looks
      where sense = ${sense} and "check" = ${check} and route = ${route}`;
    return look;
  }
}

/**
 * The artifact store as the line sees it: the pictures the probes worker took and indexed, by their hash and size. An
 * event the line appends can carry those, and the store's writer checks that each is there, as it does any artifact;
 * the line cannot read the images, and has no need to.
 */
export class IndexedArtifacts implements ArtifactStore {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async put(): Promise<string> {
    throw new Error('The line keeps no artifacts of its own: the probes worker takes the pictures');
  }

  async size(hash: string): Promise<number | null> {
    // Each column's hash is indexed (migration 0010), so this does not read every picture.
    const [row] = await this.#sql<{ size: string }[]>`
      select size from (
        select before->>'hash' as hash, before->>'size' as size from pictures where before->>'hash' = ${hash}
        union all select after->>'hash', after->>'size' from pictures where after->>'hash' = ${hash}
        union all select diff->>'hash', diff->>'size' from pictures where diff->>'hash' = ${hash}
        union all select rollout->>'hash', rollout->>'size' from pictures where rollout->>'hash' = ${hash}
      ) as shots limit 1`;
    return row ? Number(row.size) : null;
  }

  async open(): Promise<Readable | null> {
    return null;
  }
}
