/** Starts a server listening, and says when it cannot. */
import type { Server } from 'node:http';

/**
 * Listens on `port`, on every address or on `host` alone, and settles once the server listens or cannot: a port another
 * program holds, or an address the host does not have, rejects with the server's error. `server.listen` alone reports
 * that only as an `error` event, which with no listener ends the process, and leaves a promise waiting on it unsettled.
 */
export function listenOn(server: Server, port: number, host?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Whichever comes first, the other is let go of, so the server keeps no listener of this promise's either way.
    const done = () => {
      server.off('listening', listening);
      server.off('error', failed);
    };
    const listening = () => {
      done();
      resolve();
    };
    const failed = (error: Error) => {
      done();
      reject(error);
    };
    server.once('listening', listening);
    server.once('error', failed);
    try {
      server.listen(port, host);
    } catch (error) {
      // A port that is not one throws at once, and the server's next error is not this promise's.
      failed(error as Error);
    }
  });
}
