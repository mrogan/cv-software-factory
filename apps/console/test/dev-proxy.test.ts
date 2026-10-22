/**
 * `pnpm dev`'s proxy (vite.config.ts) keeps the session cookie from the console's server, as Traefik does in the cluster,
 * and passes it to the admin service, whose cookie it is.
 */
import { EventEmitter } from 'node:events';
import type { ProxyOptions } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** What each proxied path does to a request's headers on its way through. */
async function forwarded(): Promise<Record<string, string[]>> {
  vi.resetModules();
  const { default: config } = await import('../vite.config.ts');
  const proxy = (config as { server: { proxy: Record<string, string | ProxyOptions> } }).server.proxy;
  return Object.fromEntries(
    Object.entries(proxy).map(([path, entry]) => {
      const emitter = new EventEmitter();
      if (typeof entry !== 'string') entry.configure?.(emitter as never, entry);
      const headers = new Map([
        ['cookie', '__Host-session=abc'],
        ['origin', 'http://localhost:5173'],
      ]);
      emitter.emit('proxyReq', { removeHeader: (name: string) => headers.delete(name) });
      return [path, [...headers.keys()]];
    }),
  );
}

describe("pnpm dev's proxy", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("removes Cookie on the way to the console's server", async () => {
    vi.stubEnv('ADMIN_URL', 'http://localhost:8080');
    const paths = await forwarded();
    for (const path of ['/api', '/artifacts', '/health', '/version']) expect(paths[path], path).toEqual(['origin']);
  });

  it('passes it to the admin service', async () => {
    vi.stubEnv('ADMIN_URL', 'http://localhost:8080');
    expect((await forwarded())['/admin']).toEqual(['cookie', 'origin']);
  });
});
