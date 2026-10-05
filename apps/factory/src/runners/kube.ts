/**
 * The Kubernetes API, as much of it as the line needs to run jobs in the `runners` namespace: create, read and delete
 * a Job, and create a work item's volume. In the cluster it uses the pod's service account; on a host, the address
 * `kubectl proxy` serves (KUBE_API_URL), which carries the person's own credentials.
 */
import { existsSync, readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import type { z } from 'zod';

const ACCOUNT = '/var/run/secrets/kubernetes.io/serviceaccount';

export interface Kube {
  /** An object read through its schema, or undefined if there is none. */
  get<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined>;
  create(path: string, body: unknown): Promise<void>;
  remove(path: string): Promise<void>;
}

export type KubeErrorKind = 'refused' | 'invalid' | 'server' | 'malformed';

/** The API refused or failed: `refused` (401, 403), `invalid` (another 4xx), `server` (5xx), or an answer of another shape. */
export class KubeError extends Error {
  override name = 'KubeError';
  readonly status: number;
  readonly kind: KubeErrorKind;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.kind =
      status === 401 || status === 403 ? 'refused' : status >= 500 ? 'server' : status === 0 ? 'malformed' : 'invalid';
  }
}

type Send = (method: string, path: string, body?: unknown) => Promise<{ status: number; text: string }>;

export function client(send: Send): Kube {
  const check = (method: string, path: string, { status, text }: { status: number; text: string }) => {
    if (status >= 400) {
      const message = (() => {
        try {
          return (JSON.parse(text) as { message?: string }).message ?? text;
        } catch {
          return text;
        }
      })();
      throw new KubeError(status, `${method} ${path} answered ${status}: ${message}`);
    }
  };
  return {
    async get<T>(path: string, schema: z.ZodType<T>) {
      const answer = await send('GET', path);
      if (answer.status === 404) return undefined;
      check('GET', path, answer);
      const parsed = schema.safeParse(JSON.parse(answer.text));
      if (!parsed.success) throw new KubeError(0, `GET ${path} answered with something else`);
      return parsed.data;
    },
    async create(path: string, body: unknown) {
      const answer = await send('POST', path, body);
      // Made already, by an earlier attempt: the same name is the same thing.
      if (answer.status === 409) return;
      check('POST', path, answer);
    },
    async remove(path: string) {
      // In the query, not a body: a Job's pods go with it, in the background.
      const answer = await send('DELETE', `${path}?propagationPolicy=Background`);
      if (answer.status === 404) return;
      check('DELETE', path, answer);
    },
  };
}

/** The API from inside the cluster, as the pod's service account, or through `kubectl proxy` on a host. */
export function kubeFrom(env = process.env): Kube {
  if (env.KUBE_API_URL) {
    const base = env.KUBE_API_URL.replace(/\/$/, '');
    return client(async (method, path, body) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, text: await response.text() };
    });
  }
  if (!existsSync(`${ACCOUNT}/token`)) {
    throw new Error('No service account here: set KUBE_API_URL to what `kubectl proxy` serves.');
  }
  return client(
    accountSend({
      host: env.KUBERNETES_SERVICE_HOST ?? 'kubernetes.default.svc',
      port: Number(env.KUBERNETES_SERVICE_PORT ?? 443),
      ca: readFileSync(`${ACCOUNT}/ca.crt`),
      // Read again each time: Kubernetes rotates it.
      token: () => readFileSync(`${ACCOUNT}/token`, 'utf-8').trim(),
    }),
  );
}

/**
 * Requests as the pod's service account. A body goes with its length: without one, Node sends a DELETE's body unframed,
 * the API server reads the request as having none, and the bytes left over spoil the next request on the connection.
 */
export function accountSend({
  host,
  port,
  ca,
  token,
  request = httpsRequest,
}: {
  host: string;
  port: number;
  ca?: Buffer;
  token: () => string;
  request?: typeof httpsRequest;
}): Send {
  return (method, path, body) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = request(
        {
          host,
          port,
          path,
          method,
          ...(ca && { ca }),
          headers: {
            authorization: `Bearer ${token()}`,
            ...(payload && { 'content-type': 'application/json', 'content-length': payload.length }),
          },
          timeout: 30_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf-8') }));
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error(`${method} ${path} timed out`)));
      req.end(payload);
    });
}
