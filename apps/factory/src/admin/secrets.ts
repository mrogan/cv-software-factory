/**
 * The admin service's random secrets: enrolment codes, session ids and the token a session's writes carry. Each is made
 * of random bytes, never chosen by a person, so the store keeps a fast hash of it, as it keeps a job's token: nobody
 * can guess 128 random bits, and a slow, salted hash, which a password needs, protects nothing more here.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ENROLMENT_CODE } from '../../../../policy/access.ts';

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Crockford's base 32: digits and capitals, without I, L, O and U, so a code read aloud or retyped survives. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 128 random bits, as 26 of Crockford's characters, the first holding the highest three. */
const CODE_LENGTH = Math.ceil(ENROLMENT_CODE.bits / 5);

/** A new enrolment code, as `factory admin enrol` prints it: six characters, then groups of five, dashes between. */
export function newCode(): string {
  const bytes = randomBytes(ENROLMENT_CODE.bits / 8);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code = (ALPHABET[Number(value & 31n)] as string) + code;
    value >>= 5n;
  }
  return [code.slice(0, 6), ...(code.slice(6).match(/.{5}/g) ?? [])].join('-');
}

/**
 * A code as Martin typed it, in the form its hash is kept in: upper case, without dashes or spaces, and with the
 * letters Crockford reads as digits read so. Anything else is no code.
 */
export function normalCode(typed: string): string | undefined {
  const code = typed.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return code.length === CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c)) ? code : undefined;
}

/** The hash the store keeps of a code, from the code in any form `normalCode` accepts. */
export const codeHash = (code: string) => sha256(normalCode(code) ?? '');

/** A session's id: 32 random bytes, which the browser holds in its cookie and the store keeps the hash of. */
export const newSessionId = () => randomBytes(32).toString('base64url');

/** Whether a cookie's value has a session id's shape, so nothing else is hashed and looked up. */
export const isSessionId = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);

/**
 * The token a session's writes carry in a header, derived from its id, so the store keeps nothing more. A different
 * hash from the one the store keeps, so the store's copy does not give it away.
 */
export const tokenOf = (sessionId: string) =>
  createHash('sha256').update(`software-factory admin write\0${sessionId}`).digest('base64url');

/** Whether two secrets are the same, taking as long either way. */
export function same(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A WebAuthn challenge: 32 random bytes, base64url. Sent to the browser, so no secret, and used once. */
export const newChallenge = () => randomBytes(32).toString('base64url');
