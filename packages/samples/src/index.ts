/**
 * The samples: nineteen hand-written work items over eight days, with one still on the line at the end. They cover
 * every kind of work item, every outcome, every picture the design system draws and every station state. The last
 * seven are fixes as milestone 5's line makes them: rounds of review, a wait for Martin's merge, the four ways a
 * mechanism holds a fix, a merge waiting for a release, and a run on the local model. Nothing in them happened: the
 * console labels each as a sample.
 */
import type { NewEvent } from '@software-factory/events';
import { uuidFor } from './build.ts';
import pino from './items/1262-pino.ts';
import searchLogs from './items/1265-search-logs.ts';
import readsOnThursday from './items/1268-reads-on-thursday.ts';
import theLastOne from './items/1271-the-last-one.ts';
import deleteTheTest from './items/1274-delete-the-test.ts';
import otelRollback from './items/1276-otel-rollback.ts';
import nodeSecurity from './items/1282-node-security.ts';
import homePageSpeed from './items/1288-home-page-speed.ts';
import unsignedImage from './items/1293-unsigned-image.ts';
import pricesGoNegative from './items/1296-prices-go-negative.ts';
import sortByPrice from './items/1300-sort-by-price.ts';
import longWords from './items/1302-long-words.ts';
import apostrophe from './items/1304-apostrophe.ts';
import quantities from './items/1311-quantities.ts';
import stockCount from './items/1315-stock-count.ts';
import deliveryDates from './items/1317-delivery-dates.ts';
import wishlist from './items/1319-wishlist.ts';
import discountCodes from './items/1323-discount-codes.ts';
import repeatedResult from './items/1325-repeated-result.ts';

export const ITEMS = [
  pino,
  searchLogs,
  readsOnThursday,
  theLastOne,
  deleteTheTest,
  otelRollback,
  nodeSecurity,
  homePageSpeed,
  unsignedImage,
  pricesGoNegative,
  sortByPrice,
  longWords,
  apostrophe,
  quantities,
  stockCount,
  deliveryDates,
  wishlist,
  discountCodes,
  repeatedResult,
];

/** The line, running at Guarded autonomy from before the first sample. */
const LINE_STARTED: NewEvent<'line.started'> = {
  id: uuidFor('line/started'),
  ts: '2026-09-29T07:00:00.000Z',
  work_item: null,
  type: 'line.started',
  version: 1,
  actor: 'martin',
  summary: 'Martin started the line at Guarded autonomy',
  payload: { autonomy: 'guarded' },
  artifacts: [],
};

/** Every sample event in the order it happened. Events at the same moment keep the order they were written in. */
export function sampleEvents(): NewEvent[] {
  const all = [LINE_STARTED, ...ITEMS.flatMap((item) => item.events)];
  return all
    .map((event, order) => ({ event, order }))
    .sort((a, b) => Date.parse(a.event.ts) - Date.parse(b.event.ts) || a.order - b.order)
    .map(({ event }) => event);
}
