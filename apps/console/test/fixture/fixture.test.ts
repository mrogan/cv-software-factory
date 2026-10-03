import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatLog } from '@software-factory/events/log';
import { describe, expect, it } from 'vitest';
import { LOG } from './captures.ts';
import { publicFixture } from './export.ts';
import { fixtureEvents } from './items.ts';

const log = readFileSync(join(LOG, 'events.ndjson'), 'utf-8');

describe('the console’s milestone 4 test data', () => {
  it('is up to date: node apps/console/test/fixture/export.ts writes it', async () => {
    expect(log).toBe(formatLog(await publicFixture()));
  });

  it('is real work, not samples, as the states it exercises only exist in a real store', async () => {
    const opened = (await fixtureEvents()).filter((event) => event.type === 'work-item.opened');
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.every((event) => event.type === 'work-item.opened' && !event.payload.sample)).toBe(true);
  });

  it('publishes no report’s text, nor the query of the page it came from', async () => {
    for (const event of await fixtureEvents()) {
      if (event.type !== 'signal.received' || !event.payload.report?.text) continue;
      expect(log).not.toContain(event.payload.report.text.slice(0, 24));
      const query = event.payload.report.page.split('?')[1];
      if (query) expect(log).not.toContain(query);
    }
  });
});
