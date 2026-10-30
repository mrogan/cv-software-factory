/**
 * Whether the console and the app answer, asked by the probes from inside the cluster every fifteen seconds, and
 * counted by target and address (`probes.checks`), for the alerts that page Martin when either stops answering
 * (`alerts/rules.ts`, `ConsoleDown` and `AppDown`). The probes are a factory worker like any other, so Prometheus
 * watches separately that they report at all (`ProbesDown`).
 *
 * The addresses are the profile's (HEALTH_CHECKS on the probes' Deployment, each overlay's to change): every profile
 * asks each Service in the cluster, and a public one adds its public addresses beside them, each one checked, and
 * counted, on its own. Every request carries `UNMEASURED`, so a check is never a visit to the app.
 *
 * A check answers when the address gives a 2xx status within ten seconds; anything else, no answer in time included,
 * has failed. Each count starts at 0 for every target, address and outcome as the checks start, so the first failure
 * after a restart is counted too.
 */
import { metrics } from '@opentelemetry/api';
import { UNMEASURED } from '../senses/http.ts';

const meter = metrics.getMeter('factory-probes');

const checks = meter.createCounter('probes.checks', {
  description: 'Checks of whether the console and the app answer, by target, address and outcome (answered, failed)',
});

/** What a check is of: the console Martin uses, or the app visitors do. Each has an alert of its own. */
export const TARGETS = ['console', 'app'] as const;
export type Target = (typeof TARGETS)[number];

/** How a check ended. */
export const OUTCOMES = ['answered', 'failed'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** One address to check, of one target. */
export interface HealthCheck {
  target: Target;
  /** The address asked, whole. */
  url: string;
  /** The address as its series names it: its origin and path, each checked and alerted on by itself; no query. */
  address: string;
}

/** How often each address is asked. */
export const CHECK_EVERY_MS = 15_000;
/** How long an address has to answer. */
export const CHECK_TIMEOUT_MS = 10_000;

/**
 * The checks from HEALTH_CHECKS: `target=url` pairs separated by spaces, each target `console` or `app`, each url
 * http or https. Throws on anything else, so a mistyped profile fails as the probes start rather than checking nothing.
 */
export function healthChecks(text: string | undefined): HealthCheck[] {
  const found: HealthCheck[] = [];
  for (const pair of (text ?? '').split(/\s+/).filter(Boolean)) {
    const at = pair.indexOf('=');
    const target = pair.slice(0, at);
    const value = pair.slice(at + 1);
    if (at < 1 || !(TARGETS as readonly string[]).includes(target)) {
      throw new Error(`HEALTH_CHECKS: ${JSON.stringify(pair)} is not ${TARGETS.join(' or ')}=<address>`);
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`HEALTH_CHECKS: ${JSON.stringify(value)} is not an address`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`HEALTH_CHECKS: ${JSON.stringify(value)} is not an http or https address`);
    }
    found.push({ target: target as Target, url: url.href, address: `${url.origin}${url.pathname}` });
  }
  return found;
}

/** Asks one address once: answered for a 2xx status in time, failed for anything else. */
export async function check(url: string, fetcher: typeof fetch = fetch): Promise<Outcome> {
  try {
    const response = await fetcher(url, {
      headers: { ...UNMEASURED },
      redirect: 'manual',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.ok ? 'answered' : 'failed';
  } catch {
    return 'failed';
  }
}

/**
 * Starts the checks: every count from 0, then each address asked at once and every `every` after, each on its own so a
 * slow one holds up no other. Gives back what stops them, which waits for the checks in hand.
 */
export function startHealthChecks(
  list: readonly HealthCheck[],
  { every = CHECK_EVERY_MS, fetcher = fetch }: { every?: number; fetcher?: typeof fetch } = {},
): () => Promise<void> {
  for (const { target, address } of list) {
    for (const outcome of OUTCOMES) checks.add(0, { target, address, outcome });
  }
  const inHand = new Set<Promise<void>>();
  const round = () => {
    for (const { target, url, address } of list) {
      const done: Promise<void> = check(url, fetcher)
        .then((outcome) => checks.add(1, { target, address, outcome }))
        .finally(() => inHand.delete(done));
      inHand.add(done);
    }
  };
  round();
  const timer = setInterval(round, every);
  return async () => {
    clearInterval(timer);
    await Promise.all(inHand);
  };
}
