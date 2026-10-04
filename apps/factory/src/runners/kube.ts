/**
 * The Kubernetes API, as much of it as the line needs to run jobs in the `runners` namespace: create, read and delete
 * a Job, and create a work item's volume. In the cluster it uses the pod's service account; on a host, the address
 * `kubectl proxy` serves (KUBE_API_URL), which carries the person's own credentials.
 */
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:https';

const ACCOUNT = '/var/run/secrets/kubernetes.io/serviceaccount';

export interface Kube {
  get<T>(path: string): Promise<T | undefined>;
  create(path: string, body: unknown): Promise<void>;
  remove(path: string): Promise<void>;
}

class KubeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Send = (method: string, path: string, body?: unknown) => Promise<{ status: number; text: string }>;

function client(send: Send): Kube {
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
    async get<T>(path: string) {
      const answer = await send('GET', path);
      if (answer.status === 404) return undefined;
      check('GET', path, answer);
      return JSON.parse(answer.text) as T;
    },
    async create(path: string, body: unknown) {
      const answer = await send('POST', path, body);
      // Made already, by an earlier attempt: the same name is the same thing.
      if (answer.status === 409) return;
      check('POST', path, answer);
    },
    async remove(path: string) {
      const answer = await send('DELETE', path, { propagationPolicy: 'Background' });
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
  const ca = readFileSync(`${ACCOUNT}/ca.crt`);
  return client(
    (method, path, body) =>
      new Promise((resolve, reject) => {
        const req = request(
          {
            host: env.KUBERNETES_SERVICE_HOST ?? 'kubernetes.default.svc',
            port: Number(env.KUBERNETES_SERVICE_PORT ?? 443),
            path,
            method,
            ca,
            // The token is read again each time: Kubernetes rotates it.
            headers: {
              authorization: `Bearer ${readFileSync(`${ACCOUNT}/token`, 'utf-8').trim()}`,
              'content-type': 'application/json',
            },
            timeout: 30_000,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf-8') }),
            );
          },
        );
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error(`${method} ${path} timed out`)));
        req.end(body === undefined ? undefined : JSON.stringify(body));
      }),
  );
}
