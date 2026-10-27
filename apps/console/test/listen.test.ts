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

describe('listenOn', () => {
  it('settles once the server listens, on the address it is given', async () => {
    const first = server();
    await listenOn(first, 0, '127.0.0.1');
    expect(first.address()).toMatchObject({ address: '127.0.0.1' });
  });

  it('rejects when another server holds the port, and leaves no listener behind', async () => {
    const holder = server();
    await listenOn(holder, 0, '127.0.0.1');
    const second = server();
    await expect(listenOn(second, (holder.address() as AddressInfo).port, '127.0.0.1')).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
    expect(second.listenerCount('error')).toBe(0);
  });

  it('rejects a port that is not one', async () => {
    const bad = server();
    await expect(listenOn(bad, -1, '127.0.0.1')).rejects.toMatchObject({ code: 'ERR_SOCKET_BAD_PORT' });
    expect(bad.listenerCount('error')).toBe(0);
  });
});
