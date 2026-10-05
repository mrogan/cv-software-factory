/**
 * The line's Kubernetes client as the pod's service account, against a server that keeps its connections open as the
 * API server does, so each request after the first arrives on a connection an earlier one used.
 */
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountSend, client } from '../src/runners/kube.ts';

interface Heard {
  method: string;
  url: string;
  body: string;
}

const heard: Heard[] = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk: Buffer) => {
    body += chunk;
  });
  req.on('end', () => {
    heard.push({ method: req.method ?? '', url: req.url ?? '', body });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
});
let kube: ReturnType<typeof client>;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  kube = client(accountSend({ host: '127.0.0.1', port, token: () => 'token', request }));
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe('the line’s Kubernetes client', () => {
  it('deletes one Job after another, each with its pods, and then creates', async () => {
    const jobs = '/apis/batch/v1/namespaces/runners/jobs';
    await kube.remove(`${jobs}/a-prepare`);
    await kube.remove(`${jobs}/a-agent`);
    await kube.create(jobs, { kind: 'Job' });
    expect(heard).toEqual([
      { method: 'DELETE', url: `${jobs}/a-prepare?propagationPolicy=Background`, body: '' },
      { method: 'DELETE', url: `${jobs}/a-agent?propagationPolicy=Background`, body: '' },
      { method: 'POST', url: jobs, body: '{"kind":"Job"}' },
    ]);
  });
});
