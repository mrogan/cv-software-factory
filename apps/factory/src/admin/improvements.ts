/**
 * Martin's request for an improvement, from the console's "+" (`POST /admin/improvements`): his words, and an id the
 * console makes for the request. One transaction opens a work item of kind `improvement`, numbered by the store as
 * triage numbers one, titled from his first sentence (`requestTitle`, which the console shows as he types), and
 * appends his `improvement.requested` on it, with his words.
 *
 * - **The passkey again.** An improvement widens what the line does, so asking for one is `improvement.request` in the
 *   access table, which needs the passkey given within five minutes: asked by the guard, and again as the request is
 *   taken, after the lock, as it may have gone stale while it waited.
 * - **Once.** The request's id is the id of its `improvement.requested`, so a request sent again (a retry after a lost
 *   answer, a second press) opens nothing more: it is refused (409), naming the work item the first opened.
 * - **His alone.** Only Martin's roles may open an improvement or append his request (0035_improvement-requests.sql),
 *   and the line acts on an improvement only when both came from one of them.
 * - **Nothing else from the request.** The kind, the category and the title are the service's; only his words come
 *   from the body, held to the event's own rule for them.
 *
 * A visitor's suggestion never comes here: Martin, having read one, asks in his own words.
 */
import { type NewEvent, requestTitle } from '@software-factory/events';
import { PAYLOADS } from '@software-factory/events/schemas';
import { lockAppends, nextWorkItem } from '@software-factory/store';
import { z } from 'zod';
import { type AdminStore, adminEvent, Refused, type Session, steppedUpNow } from './store.ts';

/** What the "+" sends: his words, held to the event's own rule, and the request's id. */
export const REQUEST = z.strictObject({ id: z.uuid(), words: PAYLOADS['improvement.requested'].shape.words });
export type Request = z.infer<typeof REQUEST>;

/** What a request did: the work item it opened, and its title. */
export interface Requested {
  workItem: string;
  title: string;
}

/** Opens the improvement Martin asked for, with his request, or refuses having opened nothing. */
export async function requestImprovement(store: AdminStore, session: Session, asked: Request): Promise<Requested> {
  // Trimmed already, by the event's own rule for them.
  const { words } = asked;
  const title = requestTitle(words);
  const { workItem } = await store.record(
    async (tx) => {
      await lockAppends(tx);
      const [made] = await tx<
        { work_item: string | null }[]
      >`select work_item from events where id = ${asked.id} and type = 'improvement.requested'`;
      if (made) {
        throw new Refused('request', 409, `That request has been made already: it opened #${made.work_item}.`);
      }
      // Asked again as the request is taken, after the lock: the passkey given may have gone stale while it waited.
      if (!(await steppedUpNow(tx, session))) throw new Refused('step-up', 403, 'This needs your passkey again.');
      // A store of samples takes samples alone, as every append of his does.
      const [kind] = await tx<{ sample: boolean }[]>`select sample from store`;
      return { workItem: await nextWorkItem(tx), sample: kind?.sample ?? false };
    },
    ({ workItem, sample }) => [
      adminEvent(
        'work-item.opened',
        'Martin asked for an improvement from the console',
        { kind: 'improvement', title, sample, category: 'improvement' },
        workItem,
      ),
      // The request's own id, so the same request sent again is found above, and the store refuses it twice.
      {
        ...adminEvent(
          'improvement.requested',
          `Martin asked for an improvement: ${title}`,
          { words, steppedUp: true },
          workItem,
        ),
        id: asked.id,
      } as NewEvent,
    ],
  );
  return { workItem, title };
}
