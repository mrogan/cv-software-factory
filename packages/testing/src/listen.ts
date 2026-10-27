import type { Server } from 'node:net';

/** Where a test server listens: its base URL, `http://127.0.0.1:<port>`, and the port alone. */
export interface Listening {
  url: string;
  port: number;
}

/**
 * Starts a test server on a free port on 127.0.0.1, the address its tests reach it on, and resolves once it listens;
 * rejects if it cannot. A server left to listen on every address (`::`) can be given a port another program already
 * holds over IPv4 on macOS, and a request to 127.0.0.1 then reaches that program instead.
 */
export function listenLocal(server: Server): Promise<Listening> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once('error', failed);
    // biome-ignore lint/plugin: the one place a test server is given a free port.
    server.listen(0, '127.0.0.1', () => {
      server.off('error', failed);
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}`, port });
    });
  });
}
