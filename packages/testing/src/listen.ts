import type { Server } from 'node:net';
import { Server as TlsServer } from 'node:tls';

/** Where a test server listens: its base URL, `http://127.0.0.1:<port>` (`https` for a TLS server), and the port alone. */
export interface Listening {
  url: string;
  port: number;
}

/**
 * Starts a test server on a free port on 127.0.0.1, the address its tests reach it on, and resolves once it listens;
 * rejects with the server's error if it cannot, and leaves no listener of its own behind either way. A server left to
 * listen on every address (`::`) can be given a port another program already holds over IPv4 on macOS, and a request
 * to 127.0.0.1 then reaches that program instead.
 */
export function listenLocal(server: Server): Promise<Listening> {
  return new Promise((resolve, reject) => {
    const done = () => {
      server.off('listening', listening);
      server.off('error', failed);
    };
    const listening = () => {
      done();
      const { port } = server.address() as { port: number };
      resolve({ url: `${server instanceof TlsServer ? 'https' : 'http'}://127.0.0.1:${port}`, port });
    };
    const failed = (error: Error) => {
      done();
      reject(error);
    };
    server.once('listening', listening);
    server.once('error', failed);
    try {
      // biome-ignore lint/plugin: the one place a test server is given a free port.
      server.listen(0, '127.0.0.1');
    } catch (error) {
      failed(error as Error);
    }
  });
}
