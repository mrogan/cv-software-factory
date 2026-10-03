/**
 * The gateway's settings, read from the environment.
 *
 *     GATEWAY_MODE      live, record, replay or replay-record (default replay)
 *     TYPESAFE_API_KEY  the provider's key. Without it the gateway replays, whatever the mode
 *     TYPESAFE_URL      the provider's address, for a stand-in (default https://api.typesafe.ai)
 *     CASSETTES_DIR     where cassettes are recorded; also read
 *     CASSETTES_READ    more folders to read, separated by colons, such as the committed evaluation cassettes
 *     FACTORY_PROFILE   local, do or aws (default local), which chooses the spend caps in policy/spend.ts
 *     PORT              default 8080
 *     DATABASE_URL, or the PG* variables, for the store
 */
import { PROFILES, type Profile } from '../../../../policy/spend.ts';
import { MODES, type Mode } from './gateway.ts';

export interface GatewayConfig {
  mode: Mode;
  apiKey: string | undefined;
  typesafeUrl: string | undefined;
  cassettesDir: string | undefined;
  cassettesRead: string[];
  profile: Profile;
  port: number;
}

const oneOf = <T extends string>(name: string, value: string, allowed: readonly T[]): T => {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${name} is ${JSON.stringify(value)}; it must be one of ${allowed.join(', ')}.`);
  }
  return value as T;
};

export function configFromEnv(env: NodeJS.ProcessEnv): GatewayConfig {
  const apiKey = env.TYPESAFE_API_KEY || undefined;
  const config: GatewayConfig = {
    mode: oneOf('GATEWAY_MODE', env.GATEWAY_MODE || 'replay', MODES),
    apiKey,
    typesafeUrl: env.TYPESAFE_URL || undefined,
    cassettesDir: env.CASSETTES_DIR || undefined,
    cassettesRead: (env.CASSETTES_READ ?? '').split(':').filter(Boolean),
    profile: oneOf('FACTORY_PROFILE', env.FACTORY_PROFILE || 'local', PROFILES),
    port: Number(env.PORT ?? 8080),
  };
  if (apiKey && (config.mode === 'record' || config.mode === 'replay-record') && !config.cassettesDir) {
    throw new Error(`GATEWAY_MODE ${config.mode} records cassettes, so set CASSETTES_DIR to the folder for them.`);
  }
  return config;
}
