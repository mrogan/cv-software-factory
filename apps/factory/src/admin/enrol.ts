/**
 * `factory admin enrol`'s work, as the enrolment's own role, which may add a code and revoke, and nothing else: a
 * one-time code for the console's enrolment page, and, with `--revoke-others`, every passkey and session revoked first.
 * The store keeps the code's hash and sets its ten minutes; the code itself is printed once and kept nowhere.
 */
import type { Sql } from 'postgres';
import { ENROLMENT_CODE, PASSKEYS } from '../../../../policy/access.ts';
import { codeHash, newCode } from './secrets.ts';
import { adminEvent, appendMartins, lockSessions } from './store.ts';

export interface Enrolment {
  code: string;
  expiresAt: Date;
  /** The passkeys Martin still holds, by name. */
  held: { name: string; enrolledAt: Date; lastUsedAt: Date | null }[];
  /** The passkeys revoked first, by name. */
  revoked: string[];
}

/** Makes a code, revoking every passkey and session first if asked, and records each passkey revoked. */
export async function enrol(sql: Sql, { revokeOthers = false } = {}): Promise<Enrolment> {
  const code = newCode();
  return (await sql.begin(async (tx) => {
    let revoked: string[] = [];
    if (revokeOthers) {
      await lockSessions(tx);
      const rows = await tx<{ name: string }[]>`
        update passkeys set revoked_at = now() where revoked_at is null returning name`;
      revoked = rows.map((row) => row.name);
      // Revoking a passkey ends its sessions; this ends any left, whatever they were signed in with.
      await tx`update sessions set ended_at = now(), ended_by = 'revoked' where ended_at is null`;
      await appendMartins(
        sql,
        tx,
        revoked.map((name) =>
          adminEvent('passkey.revoked', 'Martin revoked a passkey', { passkey: name, from: 'command-line' }),
        ),
      );
    }
    // The store sets its ten minutes, and the enrolment may not read them back: these are near enough to print.
    const expiresAt = new Date(Date.now() + ENROLMENT_CODE.minutes * 60_000);
    await tx`insert into enrolment_codes (code_sha256) values (${codeHash(code)})`;
    const held = await tx<{ name: string; enrolled_at: Date; last_used_at: Date | null }[]>`
      select name, enrolled_at, last_used_at from passkeys where revoked_at is null order by enrolled_at`;
    return {
      code,
      expiresAt,
      held: held.map((row) => ({ name: row.name, enrolledAt: row.enrolled_at, lastUsedAt: row.last_used_at })),
      revoked,
    };
  })) as Enrolment;
}

/** What `factory admin enrol` prints. */
export function described({ code, expiresAt, held, revoked }: Enrolment): string {
  const lines = [];
  if (revoked.length)
    lines.push(`Revoked ${revoked.map((name) => `"${name}"`).join(' and ')}, and ended every session.`);
  else if (held.length) lines.push(`Passkeys held: ${held.map((passkey) => `"${passkey.name}"`).join(', ')}.`);
  if (held.length >= PASSKEYS.most) {
    lines.push(
      `That is ${PASSKEYS.most}, the most: revoke one in the console's settings, or run this again with ` +
        '--revoke-others, before enrolling another.',
    );
  }
  lines.push(
    '',
    `  ${code}`,
    '',
    `Enter it on the console's enrolment page by about ${expiresAt.toISOString().slice(11, 16)} UTC, in ` +
      `${ENROLMENT_CODE.minutes} minutes. It allows ${ENROLMENT_CODE.tries} tries, from anywhere, and makes one passkey. ` +
      'Any code printed before it can no longer be used.',
  );
  return lines.join('\n');
}
