import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { listenOn } from '../src/listen.ts';

const servers: Server[] = [];
const server = () => {
  const made = createServer();
  servers.push(made);
  return made;
};
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((each) => new Promise((resolve) => (each.listening ? each.close(resolve) : resolve(null)))),
  );
});

// The server's own listeners on the two events listenOn listens to: an HTTP server has one on 'listening'.
const listeners = (each: Server) => [each.listenerCount('error'), each.listenerCount('listening')];

describe('listenOn', () => {
  it('settles once the server listens, on the address it is given, and leaves no listener behind', async () => {
    const first = server();
    const before = listeners(first);
    await listenOn(first, 0, '127.0.0.1');
    expect(first.address()).toMatchObject({ address: '127.0.0.1' });
    expect(listeners(first)).toEqual(before);
  });

  it('rejects when another server holds the port, and leaves no listener behind', async () => {
    const holder = server();
    await listenOn(holder, 0, '127.0.0.1');
    const second = server();
    const before = listeners(second);
    await expect(listenOn(second, (holder.address() as AddressInfo).port, '127.0.0.1')).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
    expect(listeners(second)).toEqual(before);
  });

  it('rejects a port that is not one', async () => {
    const bad = server();
    const before = listeners(bad);
    await expect(listenOn(bad, -1, '127.0.0.1')).rejects.toMatchObject({ code: 'ERR_SOCKET_BAD_PORT' });
    expect(listeners(bad)).toEqual(before);
  });
});
