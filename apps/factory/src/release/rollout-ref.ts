/**
 * The app's Rollout, by name: the one the line watches and the admin service controls, as RELEASE_ROLLOUT gives it to
 * each. On its own, with nothing to import, so a command can read its setting before its telemetry starts.
 */

/** Which Rollout the line watches, and the admin service controls: the app's, in the namespace their Roles name. */
export interface RolloutRef {
  namespace: string;
  name: string;
}

/**
 * A Rollout named as `<namespace>/<name>` (RELEASE_ROLLOUT): null when the setting is empty, and undefined when it is
 * not such a name. A namespace is a DNS label; a Rollout's name, a DNS subdomain: labels joined by dots, 253
 * characters at most.
 */
export function rolloutRefOf(setting: string): RolloutRef | null | undefined {
  const given = setting.trim();
  if (given === '') return null;
  const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  const match = given.match(new RegExp(`^(${label})/(${label}(?:\\.${label})*)$`));
  if (!match?.[1] || !match[2] || match[2].length > 253) return undefined;
  return { namespace: match[1], name: match[2] };
}
