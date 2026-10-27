import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { listenLocal } from '../src/index.ts';

describe('listenLocal', () => {
  it('listens on a free port on 127.0.0.1, and gives the URL it is reached on', async () => {
    const server = createServer((_request, response) => response.end('here'));
    const { url, port } = await listenLocal(server);
    try {
      expect(server.address()).toMatchObject({
        address: '127.0.0.1',
        family: 'IPv4',
        port,
      } satisfies Partial<AddressInfo>);
      expect(url).toBe(`http://127.0.0.1:${port}`);
      expect(await (await fetch(url)).text()).toBe('here');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('rejects when the server cannot listen, and leaves no listener behind', async () => {
    const server = createServer();
    const taken = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    server.listen = (() => {
      queueMicrotask(() => server.emit('error', taken));
      return server;
    }) as typeof server.listen;
    await expect(listenLocal(server)).rejects.toBe(taken);
    expect(server.listenerCount('error')).toBe(0);
  });
});
