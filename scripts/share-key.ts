/**
 * The traffic generator's signing key, as `make share-key` makes it: an Ed25519 key pair, whose private half goes to
 * the generator's Secret and whose public half goes to the app's ConfigMap `share-key`. Each passes through a pipe,
 * never a file or a command line. `make refusal-key` makes the GitHub worker's key for signing its refusals with it the
 * same way (the Secret `refusal-signing-key`, and the ConfigMap `refusal-key` the line reads).
 *
 *     node scripts/share-key.ts new | kubectl -n factory create secret generic share-signing-key …
 *     kubectl … get secret share-signing-key … | node scripts/share-key.ts public | kubectl -n website create configmap …
 *
 * `new` prints a new private key (PKCS #8, PEM). `public` reads a private key (PEM) on stdin and prints its public
 * key (SPKI, PEM), and refuses anything but an Ed25519 private key, so a broken Secret never becomes an empty or wrong
 * ConfigMap. A refusal never quotes what it read.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** A new private key, PEM. */
export function newKey(): string {
  return generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
}

/** The public half of an Ed25519 private key, both PEM. */
export function publicKey(privatePem: string): string {
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(privatePem);
  } catch {
    throw new Error('That is not a private key in PEM.');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`That is a ${key.asymmetricKeyType} key, not Ed25519.`);
  return createPublicKey(key).export({ type: 'spki', format: 'pem' }) as string;
}

if (import.meta.main) {
  const [command] = process.argv.slice(2);
  try {
    if (command === 'new') process.stdout.write(newKey());
    else if (command === 'public') process.stdout.write(publicKey(readFileSync(0, 'utf-8')));
    else {
      console.error('Usage: node scripts/share-key.ts new | public');
      process.exit(2);
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
