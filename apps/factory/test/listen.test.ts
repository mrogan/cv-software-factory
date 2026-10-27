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
    servers.splice(0).map((s) => new Promise((resolve) => (s.listening ? s.close(resolve) : resolve(undefined)))),
  );
});

// The server's own listeners on the two events listenOn listens to: an HTTP server has one on 'listening'.
const listeners = (s: Server) => [s.listenerCount('error'), s.listenerCount('listening')];

describe('listening', () => {
  it('settles once the server listens, and leaves no listener behind', async () => {
    const listening = server();
    const before = listeners(listening);
    await listenOn(listening, 0, '127.0.0.1');
    expect(listening.listening).toBe(true);
    expect((listening.address() as AddressInfo).address).toBe('127.0.0.1');
    expect(listeners(listening)).toEqual(before);
  });

  it('rejects with the error when the port is held, rather than leaving it to end the process', async () => {
    const holder = server();
    await listenOn(holder, 0, '127.0.0.1');
    const { port } = holder.address() as AddressInfo;

    const second = server();
    const before = listeners(second);
    await expect(listenOn(second, port, '127.0.0.1')).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(second.listening).toBe(false);
    expect(listeners(second)).toEqual(before);
  });

  it('rejects a port that is not one, and leaves the server’s next error to it', async () => {
    const bad = server();
    const before = listeners(bad);
    await expect(listenOn(bad, Number('abc'), '127.0.0.1')).rejects.toMatchObject({ code: 'ERR_SOCKET_BAD_PORT' });
    expect(listeners(bad)).toEqual(before);
  });
});
