/**
 * A software authenticator for the admin service's tests: it makes a passkey and gives it, as a browser and a device
 * would, answering the service's own options. It lives in the tests alone; the image has no sign-in made for tests.
 *
 * Each answer can be made wrong in one way at a time (another origin, another relying party, no user verification),
 * so the tests can show the service refuses each.
 */
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';

export interface Ceremony {
  /** The origin the browser says it is on. */
  origin?: string;
  /** The relying party the authenticator signs for. */
  rpId?: string;
  /** Whether the person was verified (a fingerprint, a face, a PIN). */
  verified?: boolean;
  /** The challenge signed, in place of the one the options gave. */
  challenge?: string;
}

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest();
const b64 = (data: Uint8Array) => Buffer.from(data).toString('base64url');

/** User present, user verified, and attested credential data included. */
const FLAGS = { up: 0x01, uv: 0x04, at: 0x40 };

export class Authenticator {
  readonly id = randomBytes(32);
  readonly #key: KeyObject;
  readonly #public: KeyObject;
  readonly #origin: string;
  readonly #rpId: string;
  #counter = 0;

  constructor(origin: string, rpId: string) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.#key = privateKey;
    this.#public = publicKey;
    this.#origin = origin;
    this.#rpId = rpId;
  }

  get credentialId(): string {
    return b64(this.id);
  }

  /** Makes this passkey, answering `navigator.credentials.create()`'s options as a browser's JSON gives them. */
  create(options: { challenge: string }, ceremony: Ceremony = {}) {
    const clientData = this.#clientData('webauthn.create', options.challenge, ceremony);
    const jwk = this.#public.export({ format: 'jwk' });
    // The credential's public key, COSE-encoded: EC2, ES256, P-256, and its point.
    const cose = cbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x as string, 'base64url')],
        [-3, Buffer.from(jwk.y as string, 'base64url')],
      ]),
    );
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([
      this.#authData(ceremony, FLAGS.at),
      Buffer.alloc(16), // no AAGUID: attestation is not asked for
      idLength,
      this.id,
      cose,
    ]);
    const attestationObject = cbor(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64(clientData),
        attestationObject: b64(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** Gives this passkey, answering `navigator.credentials.get()`'s options. */
  get(options: { challenge: string }, ceremony: Ceremony = {}) {
    this.#counter++;
    const clientData = this.#clientData('webauthn.get', options.challenge, ceremony);
    const authData = this.#authData(ceremony, 0);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.#key);
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64(clientData),
        authenticatorData: b64(authData),
        signature: b64(signature),
        userHandle: b64(new TextEncoder().encode('martin')),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  #clientData(type: string, challenge: string, ceremony: Ceremony): Buffer {
    return Buffer.from(
      JSON.stringify({
        type,
        challenge: ceremony.challenge ?? challenge,
        origin: ceremony.origin ?? this.#origin,
        crossOrigin: false,
      }),
    );
  }

  #authData(ceremony: Ceremony, extra: number): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.#counter);
    const flags = FLAGS.up | (ceremony.verified === false ? 0 : FLAGS.uv) | extra;
    return Buffer.concat([sha256(ceremony.rpId ?? this.#rpId), Buffer.from([flags]), counter]);
  }
}

/** Enough of CBOR (RFC 8949) for an attestation: integers, byte and text strings, and maps. */
export function cbor(value: unknown): Buffer {
  const head = (major: number, length: number) => {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
    if (length < 0x10000) {
      const b = Buffer.alloc(3);
      b[0] = (major << 5) | 25;
      b.writeUInt16BE(length, 1);
      return b;
    }
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(length, 1);
    return b;
  };
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf-8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) {
    return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  }
  throw new Error(`cbor cannot encode ${typeof value}`);
}
