import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { listen } from '../src/listen.ts';

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

describe('listening', () => {
  it('settles once the server listens, and leaves no error listener behind', async () => {
    const listening = server();
    await listen(listening, 0, '127.0.0.1');
    expect(listening.listening).toBe(true);
    expect((listening.address() as AddressInfo).address).toBe('127.0.0.1');
    expect(listening.listenerCount('error')).toBe(0);
  });

  it('rejects with the error when the port is held, rather than leaving it to end the process', async () => {
    const holder = server();
    await listen(holder, 0, '127.0.0.1');
    const { port } = holder.address() as AddressInfo;

    const second = server();
    await expect(listen(second, port, '127.0.0.1')).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(second.listening).toBe(false);
    expect(second.listenerCount('error')).toBe(0);
  });
});
