/**
 * The samples: about twelve hand-written work items over five days, with one still on the line at the end. They
 * cover every kind of work item, every outcome, every picture the design system draws and every station state.
 * Nothing in them happened: the console labels each as a sample.
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
