import { createServer } from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { listenLocal } from '../src/index.ts';

const close = (server: { close: (done: () => void) => unknown }) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

// The server's own listeners on the two events listenLocal listens to: an HTTP server has one on 'listening'.
const listeners = (server: Server) => [server.listenerCount('error'), server.listenerCount('listening')];

describe('listenLocal', () => {
  it('listens on a free port on 127.0.0.1, and gives the URL it is reached on', async () => {
    const server = createServer((_request, response) => response.end('here'));
    const before = listeners(server);
    const { url, port } = await listenLocal(server);
    try {
      expect(server.address()).toMatchObject({
        address: '127.0.0.1',
        family: 'IPv4',
        port,
      } satisfies Partial<AddressInfo>);
      expect(url).toBe(`http://127.0.0.1:${port}`);
      expect(await (await fetch(url)).text()).toBe('here');
      expect(listeners(server)).toEqual(before);
    } finally {
      await close(server);
    }
  });

  it('gives an https URL for a TLS server', async () => {
    const server = createTlsServer();
    const { url, port } = await listenLocal(server);
    try {
      expect(url).toBe(`https://127.0.0.1:${port}`);
    } finally {
      await close(server);
    }
  });

  it('rejects with the error the server emits, and leaves no listener behind', async () => {
    const server = createServer();
    const before = listeners(server);
    const taken = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    server.listen = (() => {
      queueMicrotask(() => server.emit('error', taken));
      return server;
    }) as typeof server.listen;
    await expect(listenLocal(server)).rejects.toBe(taken);
    expect(listeners(server)).toEqual(before);
  });

  it('rejects with the error listen throws, and leaves no listener behind', async () => {
    const server = createServer();
    await listenLocal(server);
    const before = listeners(server);
    try {
      await expect(listenLocal(server)).rejects.toMatchObject({ code: 'ERR_SERVER_ALREADY_LISTEN' });
      expect(listeners(server)).toEqual(before);
    } finally {
      await close(server);
    }
  });
});
