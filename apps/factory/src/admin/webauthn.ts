/**
 * Passkeys (WebAuthn), through SimpleWebAuthn: the options each ceremony sends the browser, and the checks of what the
 * passkey answers. User verification is required in both, and the origin and the relying party are the configured
 * ones, never the request's. Attestation is not asked for: Martin's passkeys are whatever his devices make, and the
 * one-time code, not the authenticator's maker, is what proves him.
 */
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { z } from 'zod';
import type { AdminConfig } from './config.ts';
import { CEREMONY_MINUTES, type Passkey, type PasskeyListed } from './store.ts';

/** EdDSA, ES256 and RS256: what every platform's passkeys use. */
const ALGORITHMS = [-8, -7, -257];

/** Martin, the one user: the same handle on every passkey, so a device keeps one of his at a time. */
const USER = { id: new TextEncoder().encode('martin'), name: 'martin', displayName: 'Martin Rogan' };

const TIMEOUT_MS = CEREMONY_MINUTES * 60_000;

const base64url = z
  .string()
  .regex(/^[A-Za-z0-9_-]*$/)
  .max(16_384);

/** A passkey's answer, in the shape the browser's JSON gives it; SimpleWebAuthn checks the rest. */
const answer = z.looseObject({
  id: base64url.min(16).max(1364),
  rawId: base64url,
  type: z.literal('public-key'),
  response: z.looseObject({ clientDataJSON: base64url }),
  clientExtensionResults: z.looseObject({}),
});

export const registrationAnswer = answer.extend({
  response: z.looseObject({ clientDataJSON: base64url, attestationObject: base64url }),
});
export const authenticationAnswer = answer.extend({
  response: z.looseObject({ clientDataJSON: base64url, authenticatorData: base64url, signature: base64url }),
});

/**
 * A challenge as bytes, as the options take it: given a string, SimpleWebAuthn would send its UTF-8 bytes, and the
 * browser would sign a challenge other than the one the store keeps.
 */
const bytesOf = (challenge: string) => new Uint8Array(Buffer.from(challenge, 'base64url'));

/** The challenge a passkey's answer signed, from its client data, or undefined if it names none. */
export function challengeOf(response: { response: { clientDataJSON: string } }): string | undefined {
  try {
    const data = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf-8'));
    return typeof data?.challenge === 'string' && /^[A-Za-z0-9_-]{22,128}$/.test(data.challenge)
      ? data.challenge
      : undefined;
  } catch {
    return undefined;
  }
}

/** What the browser needs to make a passkey: resident, so signing in needs no list of them, and verified. */
export function registrationOptions(
  config: AdminConfig,
  challenge: string,
  held: readonly PasskeyListed[],
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: 'Software Factory',
    rpID: config.rpId,
    userID: USER.id,
    userName: USER.name,
    userDisplayName: USER.displayName,
    challenge: bytesOf(challenge),
    timeout: TIMEOUT_MS,
    attestationType: 'none',
    excludeCredentials: held.map((passkey) => ({ id: passkey.id })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    supportedAlgorithmIDs: ALGORITHMS,
  });
}

/** The new passkey, if the answer is a verified one, for this challenge, origin and relying party. */
export async function verifyRegistration(
  config: AdminConfig,
  response: RegistrationResponseJSON,
  challenge: string,
): Promise<{ id: string; publicKey: Uint8Array; signCount: number; transports: string[] } | undefined> {
  const verified = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: config.origin,
    expectedRPID: config.rpId,
    expectedType: 'webauthn.create',
    requireUserPresence: true,
    requireUserVerification: true,
    supportedAlgorithmIDs: ALGORITHMS,
  });
  if (!verified.verified) return undefined;
  const { credential, userVerified } = verified.registrationInfo;
  if (!userVerified) return undefined;
  return {
    id: credential.id,
    publicKey: credential.publicKey,
    signCount: credential.counter,
    transports: [...(credential.transports ?? [])],
  };
}

/** What the browser needs to give a passkey: any of Martin's, or the one named, and verified. */
export function authenticationOptions(
  config: AdminConfig,
  challenge: string,
  only?: Pick<Passkey, 'id' | 'transports'>,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: config.rpId,
    challenge: bytesOf(challenge),
    timeout: TIMEOUT_MS,
    userVerification: 'required',
    // Signing in names none, so nobody without a session learns a passkey's id.
    allowCredentials: only ? [{ id: only.id, transports: only.transports }] : [],
  });
}

/** The passkey's new signature counter, if the answer is a verified assertion by it, for this challenge. */
export async function verifyAuthentication(
  config: AdminConfig,
  response: AuthenticationResponseJSON,
  challenge: string,
  passkey: Passkey,
): Promise<number | undefined> {
  const verified = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: config.origin,
    expectedRPID: config.rpId,
    expectedType: 'webauthn.get',
    requireUserVerification: true,
    credential: { id: passkey.id, publicKey: passkey.publicKey, counter: passkey.signCount },
  });
  if (!verified.verified || !verified.authenticationInfo.userVerified) return undefined;
  return verified.authenticationInfo.newCounter;
}
