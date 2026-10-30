import { createServer, type IncomingHttpHeaders } from 'node:http';
import { listenLocal } from '@software-factory/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exchange, pathOf, UNMEASURED, versionOf } from '../../src/senses/http.ts';

const seen: IncomingHttpHeaders[] = [];
const server = createServer((req, res) => {
  seen.push(req.headers);
  if (req.url === '/moved') return void res.writeHead(302, { location: '/version' }).end();
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ commit: 'a'.repeat(40) }));
});
let app: string;

beforeAll(async () => {
  app = (await listenLocal(server)).url;
});
afterAll(() => server.close());

describe('asking the app', () => {
  it('sends the headers it is given, after a redirect too, and none unless given', async () => {
    seen.length = 0;
    await exchange(app, '/moved', { headers: UNMEASURED });
    expect(await versionOf(app, UNMEASURED)).toBe('a'.repeat(40));
    expect(seen).toHaveLength(3);
    for (const headers of seen) expect(headers).toMatchObject(UNMEASURED);

    seen.length = 0;
    await versionOf(app);
    expect(Object.keys(UNMEASURED).filter((name) => name in (seen[0] ?? {}))).toEqual([]);
  });

  it('records a path cut as before, an emoji in it percent-encoded, so never split', () => {
    const plain = `/search?q=${'a'.repeat(400)}`;
    expect(pathOf(plain, 'http://app.test')).toBe(plain.slice(0, 300));
    const emoji = pathOf(`/${'a'.repeat(298)}\u{1F600}`, 'http://app.test');
    expect(emoji).toBe(`/${'a'.repeat(298)}%`);
    expect(emoji.isWellFormed()).toBe(true);
  });
});
