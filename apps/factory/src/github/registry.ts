/**
 * GHCR, read through the registry's own API (the OCI distribution API), anonymously: the factory's and the app's
 * images are public, and a GitHub App cannot read a user's packages through GitHub's REST API.
 *
 *     tags(image)            every tag of an image, such as `mrogan/cv-software-factory/console`
 *     digest(image, tag)     the digest the tag points at: the image index, for a multi-platform build
 *     revision(image, ref)   the commit the image was built from, from its `org.opencontainers.image.revision` label
 */
import { z } from 'zod';

export const GHCR = 'https://ghcr.io';

export const DIGEST = /^sha256:[0-9a-f]{64}$/;

const TOKEN = z.object({ token: z.string().min(1) });
const TAGS = z.object({ tags: z.array(z.string()).nullable().optional() });
const MANIFEST = z.object({
  manifests: z
    .array(z.object({ digest: z.string().regex(DIGEST), platform: z.object({ os: z.string().optional() }).optional() }))
    .optional(),
  config: z.object({ digest: z.string().regex(DIGEST) }).optional(),
});
const CONFIG = z.object({
  config: z.object({ Labels: z.record(z.string(), z.string()).nullable().optional() }).optional(),
});

/** An answer read through its schema, or an error that names what was asked. */
async function json<T>(response: Response, schema: z.ZodType<T>, what: string): Promise<T> {
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new Error(`ghcr.io answered ${what} with something else`);
  return parsed.data;
}

const INDEX_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export interface RegistryOptions {
  base?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class Registry {
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #tokens = new Map<string, string>();
  /** A digest's revision never changes, so each is read once. */
  readonly #revisions = new Map<string, string | undefined>();

  constructor({ base = GHCR, fetch: fetcher = fetch, timeoutMs = 15_000 }: RegistryOptions = {}) {
    this.#base = base;
    this.#fetch = fetcher;
    this.#timeoutMs = timeoutMs;
  }

  async tags(image: string): Promise<string[]> {
    const tags: string[] = [];
    let path: string | null = `/v2/${image}/tags/list?n=1000`;
    while (path) {
      const response = await this.#get(image, path, 'application/json');
      tags.push(...((await json(response, TAGS, `the tags of ${image}`)).tags ?? []));
      // The next page, if any, is in a Link header: `</v2/…/tags/list?last=…&n=1000>; rel="next"`.
      path = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1] ?? null;
    }
    return tags;
  }

  async digest(image: string, tag: string): Promise<string> {
    const response = await this.#get(image, `/v2/${image}/manifests/${tag}`, INDEX_TYPES, 'HEAD');
    const digest = response.headers.get('docker-content-digest');
    // Checked whole: it goes into a pin file, and from there to the cluster.
    if (!digest || !DIGEST.test(digest)) throw new Error(`ghcr.io gave no digest for ${image}:${tag}`);
    return digest;
  }

  /** The one commit an image (by tag or digest) says it was built from, or undefined if it names none or several. */
  async revision(image: string, reference: string): Promise<string | undefined> {
    const key = `${image}@${reference}`;
    if (reference.startsWith('sha256:') && this.#revisions.has(key)) return this.#revisions.get(key);
    const revision = await this.#revision(image, reference);
    if (reference.startsWith('sha256:')) this.#revisions.set(key, revision);
    return revision;
  }

  async #revision(image: string, reference: string): Promise<string | undefined> {
    const manifest = (path: string) => this.#get(image, path, INDEX_TYPES).then((r) => json(r, MANIFEST, path));
    const index = await manifest(`/v2/${image}/manifests/${reference}`);
    // An index lists one manifest per platform, and attestations that name no OS; each platform's config has the labels.
    const configs = index.config
      ? [index.config.digest]
      : await Promise.all(
          (index.manifests ?? [])
            .filter((m) => m.platform?.os && m.platform.os !== 'unknown')
            .map(async (m) => {
              const platform = await manifest(`/v2/${image}/manifests/${m.digest}`);
              if (!platform.config) throw new Error(`ghcr.io gave a platform of ${image} no config`);
              return platform.config.digest;
            }),
        );
    const revisions = new Set<string>();
    for (const digest of new Set(configs)) {
      const path = `/v2/${image}/blobs/${digest}`;
      const config = await json(await this.#get(image, path, 'application/json'), CONFIG, path);
      const revision = config.config?.Labels?.['org.opencontainers.image.revision'];
      if (revision) revisions.add(revision);
    }
    return revisions.size === 1 ? [...revisions][0] : undefined;
  }

  async #token(image: string): Promise<string> {
    const cached = this.#tokens.get(image);
    if (cached) return cached;
    const response = await this.#fetch(`${this.#base}/token?scope=repository:${image}:pull`, {
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) throw new Error(`ghcr.io refused an anonymous token for ${image}: ${response.status}`);
    const { token } = await json(response, TOKEN, `an anonymous token for ${image}`);
    this.#tokens.set(image, token);
    return token;
  }

  async #get(image: string, path: string, accept: string, method: 'GET' | 'HEAD' = 'GET'): Promise<Response> {
    for (let renewed = false; ; renewed = true) {
      const response = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers: { accept, authorization: `Bearer ${await this.#token(image)}` },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      // Anonymous tokens last minutes; an expired one is made again, once.
      if (response.status === 401 && !renewed) {
        this.#tokens.delete(image);
        continue;
      }
      if (!response.ok) throw new Error(`ghcr.io answered ${response.status} for ${method} ${path}`);
      return response;
    }
  }
}
