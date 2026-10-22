/**
 * The admin service, as a browser and a passkey use it: a software authenticator answers its ceremonies, and each test
 * is a request the service must refuse or a flow it must allow. Martin's sign-in path is held to the plan's list:
 *
 * - every write route refuses no session, an expired one, a revoked one, the wrong origin and a missing token;
 * - enrolment refuses no code, a used one, an expired one and a sixth try;
 * - the cookie's flags, and a new id at sign-in;
 * - a challenge cannot be used twice, and an assertion with the wrong origin, the wrong relying party or no user
 *   verification is refused;
 * - step-up is enforced on every action the table marks;
 * - signing out, revoking and expiry close an open full-event stream;
 * - forwarded headers from anywhere but the proxy are ignored.
 */
import type { AddressInfo } from 'node:net';
import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import { PASSWORDS } from '../../../../packages/store/test/postgres.ts';
import {
  ACCESS,
  type Access,
  ENROLMENT_CODE,
  type Name,
  routeOf,
  SESSION,
  STEP_UP,
} from '../../../../policy/access.ts';
import { CONTENT_SECURITY_POLICY, COOKIE } from '../../src/admin/app.ts';
import type { AdminConfig } from '../../src/admin/config.ts';
import { proxies } from '../../src/admin/config.ts';
import { described, enrol } from '../../src/admin/enrol.ts';
import { refuseWrite } from '../../src/admin/guard.ts';
import { sha256, tokenOf } from '../../src/admin/secrets.ts';
import { type AdminService, startAdmin } from '../../src/admin/service.ts';
import type { Session } from '../../src/admin/store.ts';
import { Authenticator, type Ceremony } from './authenticator.ts';

const ORIGIN = 'https://console.localhost:8443';
const RP_ID = 'console.localhost';

let db: Database;
let service: AdminService;
let base: string;

/** A connection as a role, to this file's database. */
const as = (username: string, password: string): Sql => {
  const url = new URL(inject('databaseUrl'));
  return postgres({
    host: url.hostname,
    port: Number(url.port),
    database: db.name,
    username,
    password,
    max: 4,
    onnotice: () => {},
  });
};

const start = async (config: Partial<AdminConfig> = {}) => {
  service = await startAdmin(
    { origin: ORIGIN, rpId: RP_ID, trusted: proxies(''), port: 0, ...config },
    { sql: as('factory_admin', PASSWORDS.admin), port: 0, recheckMs: 100 },
  );
  base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
};

beforeAll(async () => {
  db = await freshDatabase('admin');
});
afterAll(() => db?.end());

beforeEach(async () => {
  // Each test starts with no passkeys held, and so no session live: a passkey revoked ends its sessions.
  await db.owner`update passkeys set revoked_at = now() where revoked_at is null`;
  await start();
});
afterEach(() => service?.stop());

type Body = Record<string, unknown>;

/** A browser on the console's page: its session cookie and the token its writes carry. */
class Browser {
  cookie: string | undefined;
  token: string | undefined;
  /** The last `set-cookie` the service sent, as it sent it. */
  setCookie: string | undefined;

  async post(
    path: string,
    body: Body = {},
    { origin = ORIGIN, token = this.token, headers = {} as Record<string, string> } = {},
  ): Promise<{ status: number; body: Body }> {
    return this.#send(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(origin && { origin }),
        ...(token && { 'x-csrf-token': token }),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Body }> {
    return this.#send(path, { headers });
  }

  async #send(path: string, init: RequestInit): Promise<{ status: number; body: Body }> {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        ...(this.cookie && { cookie: `${COOKIE}=${this.cookie}` }),
      },
    });
    const set = res.headers.get('set-cookie');
    if (set) {
      this.setCookie = set;
      const value = /^__Host-session=([^;]*)/.exec(set)?.[1];
      this.cookie = value || undefined;
      if (!value) this.token = undefined;
    }
    const body = (await res.json()) as Body;
    if (typeof body.token === 'string') this.token = body.token;
    return { status: res.status, body };
  }
}

/** A code from `factory admin enrol`, as the enrolment's own role makes it. */
const newCode = async () => (await enrol(db.enrol)).code;

/** Enrols a passkey with a code, as the enrolment page does, signing the browser in. */
async function enrolWith(browser: Browser, passkey: Authenticator, code: string, ceremony: Ceremony = {}) {
  const options = await browser.post('/admin/enrol/options', { code });
  if (options.status !== 200) return options;
  return browser.post('/admin/enrol', {
    response: passkey.create(options.body as { challenge: string }, ceremony),
    name: 'Laptop',
  });
}

/** A browser signed in with a new passkey, and the passkey. */
async function signedIn(): Promise<{ browser: Browser; passkey: Authenticator }> {
  const browser = new Browser();
  const passkey = new Authenticator(ORIGIN, RP_ID);
  const enrolled = await enrolWith(browser, passkey, await newCode());
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(200);
  return { browser, passkey };
}

async function signIn(browser: Browser, passkey: Authenticator, ceremony: Ceremony = {}) {
  const options = await browser.post('/admin/sign-in/options');
  expect(options.status).toBe(200);
  return browser.post('/admin/sign-in', { response: passkey.get(options.body as { challenge: string }, ceremony) });
}

async function stepUp(browser: Browser, passkey: Authenticator) {
  const options = await browser.post('/admin/step-up/options');
  expect(options.status).toBe(200);
  return browser.post('/admin/step-up', { response: passkey.get(options.body as { challenge: string }) });
}

const sessionOf = (browser: Browser) => sha256(browser.cookie ?? '');

/** Ends a session's eight hours, as the store's clock would. */
const expire = (browser: Browser) => db.owner`
  update sessions set signed_in_at = now() - interval '9 hours', expires_at = now() - interval '1 hour'
  where id_sha256 = ${sessionOf(browser)}`;

const lastEvents = (n: number) => db.owner<
  { type: string; actor: string; summary: string; payload: Body; public: Body }[]
>`
  select type, actor, summary, payload, public from events order by seq desc limit ${n}`;

describe('the admin service’s routes', () => {
  it('are those the access table gives it, each answered, and nothing else', async () => {
    const browser = new Browser();
    for (const [name, access] of Object.entries(ACCESS) as [Name, Access][]) {
      if (access.server !== 'admin') continue;
      for (const route of access.routes ?? []) {
        const [method = '', path = ''] = route.split(' ');
        const res = await fetch(`${base}${path.replace(':id', 'x'.repeat(20))}`, {
          method: String(method),
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          ...(method === 'POST' && { body: '{}' }),
        });
        await res.body?.cancel();
        expect(res.status, `${name}: ${route}`).not.toBe(404);
      }
    }
    for (const [method, path] of [
      ['GET', '/admin/'],
      ['GET', '/admin/sign-in'],
      ['GET', '/admin/sign-out'],
      ['PUT', '/admin/sign-out'],
      ['DELETE', '/admin/passkeys/x/revoke'],
      ['POST', '/admin/session'],
      ['GET', '/health'],
      ['GET', '/'],
      ['GET', '/admin/hold/1/approve'],
    ] as const) {
      const res = await fetch(`${base}${path}`, { method, headers: { origin: ORIGIN } });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect((await browser.get('/admin/health')).body).toEqual({ status: 'ok' });
  });

  it('send a strict policy, HSTS and no-store with every response, refusals and 404s included', async () => {
    for (const [method, path] of [
      ['GET', '/admin/health'],
      ['GET', '/admin/session'],
      ['POST', '/admin/sign-out'],
      ['GET', '/nowhere'],
    ]) {
      const res = await fetch(`${base}${path}`, { method: String(method) });
      await res.body?.cancel();
      expect(res.headers.get('content-security-policy'), path).toBe(CONTENT_SECURITY_POLICY);
      expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
      expect(CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
      expect(res.headers.get('strict-transport-security'), path).toBe('max-age=31536000');
      expect(res.headers.get('cache-control'), path).toBe('no-store');
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
    }
  });
});

describe('enrolment', () => {
  it('makes a passkey with a code, and signs in with a session cookie that is Secure, HttpOnly and SameSite=Strict', async () => {
    const browser = new Browser();
    const passkey = new Authenticator(ORIGIN, RP_ID);
    const res = await enrolWith(browser, passkey, await newCode());
    expect(res.status).toBe(200);
    expect(browser.setCookie).toBe(
      `${COOKIE}=${browser.cookie}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION.hours * 3600}`,
    );
    expect(browser.cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The store keeps the id's hash, never the id.
    expect(await db.owner`select 1 from sessions where id_sha256 = ${sessionOf(browser)}`).toHaveLength(1);
    expect(await db.owner`select 1 from sessions where id_sha256 = ${browser.cookie ?? ''}`).toHaveLength(0);
    const session = await browser.get('/admin/session');
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ passkey: { id: passkey.credentialId, name: 'Laptop' }, steppedUp: false });
    expect(session.body.token).toBe(tokenOf(browser.cookie ?? ''));
    // Recorded as Martin's, his passkey's name in the full events and not in the public views.
    const [signedIn, enrolled] = await lastEvents(2);
    expect(enrolled).toMatchObject({ type: 'passkey.enrolled', actor: 'martin', payload: { passkey: 'Laptop' } });
    expect(signedIn).toMatchObject({ type: 'admin.signed-in', actor: 'martin', payload: { passkey: 'Laptop' } });
    expect(enrolled?.public).toMatchObject({ summary: 'Martin enrolled a passkey', payload: {} });
    expect(signedIn?.public).toMatchObject({ summary: 'Martin signed in with a passkey', payload: {} });
    expect(JSON.stringify([enrolled?.public, signedIn?.public])).not.toContain('Laptop');
  });

  it('refuses no code, a code that is not one, a used one and an expired one', async () => {
    const browser = new Browser();
    expect((await browser.post('/admin/enrol/options', {})).status).toBe(400);
    expect((await browser.post('/admin/enrol/options', { code: '' })).status).toBe(400);
    expect((await browser.post('/admin/enrol/options', { code: 'AAAAAA-AAAAA-AAAAA-AAAAA-AAAAA' })).body.refused).toBe(
      'code',
    );

    const used = await newCode();
    expect((await enrolWith(new Browser(), new Authenticator(ORIGIN, RP_ID), used)).status).toBe(200);
    const again = await new Browser().post('/admin/enrol/options', { code: used });
    expect(again).toMatchObject({ status: 403, body: { refused: 'code', left: 0 } });

    const expired = await newCode();
    await db.owner`
      update enrolment_codes set created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute'
      where code_sha256 = ${sha256(expired.replaceAll('-', ''))}`;
    expect(await new Browser().post('/admin/enrol/options', { code: expired })).toMatchObject({
      status: 403,
      body: { refused: 'code' },
    });
  });

  it('allows five tries of a code, counted across every client, and refuses the sixth', async () => {
    const code = await newCode();
    expect(ENROLMENT_CODE.tries).toBe(5);
    // Four wrong codes from four browsers, then the right one: five tries.
    for (let i = 0; i < 4; i++) {
      const wrong = await new Browser().post('/admin/enrol/options', { code: 'ZZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ' });
      // Each says how many tries the live code has left, so the page can say so.
      expect(wrong).toMatchObject({ status: 403, body: { refused: 'code', left: 4 - i } });
    }
    expect((await new Browser().post('/admin/enrol/options', { code })).status).toBe(200);
    // The sixth is refused, however right, as a code that can no longer be used.
    expect(await new Browser().post('/admin/enrol/options', { code })).toMatchObject({
      status: 403,
      body: { refused: 'code', left: 0 },
    });
  });

  it('counts no try for what cannot be a code, so junk cannot burn Martin’s', async () => {
    const code = await newCode();
    for (let i = 0; i < 6; i++) {
      expect((await new Browser().post('/admin/enrol/options', { code: 'not a code' })).status).toBe(400);
    }
    expect((await new Browser().post('/admin/enrol/options', { code })).status).toBe(200);
  });

  it('opens no stream for HEAD', async () => {
    const { browser } = await signedIn();
    const res = await fetch(`${base}/admin/events/stream`, {
      method: 'HEAD',
      headers: { cookie: `${COOKIE}=${browser.cookie}` },
    });
    expect(res.status).toBe(200);
    expect(service.events.open).toBe(0);
  });

  it('accepts the code with or without its dashes, in any case', async () => {
    const code = await newCode();
    const typed = code.replaceAll('-', ' ').toLowerCase();
    expect((await enrolWith(new Browser(), new Authenticator(ORIGIN, RP_ID), typed)).status).toBe(200);
  });

  it('checks Origin, takes JSON alone, and is the only way to add a passkey, a session or no', async () => {
    const code = await newCode();
    const browser = new Browser();
    expect((await browser.post('/admin/enrol/options', { code }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await browser.post('/admin/enrol/options', { code }, { origin: '' })).status).toBe(403);
    const form = await fetch(`${base}/admin/enrol/options`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
      body: `code=${code}`,
    });
    await form.body?.cancel();
    expect(form.status).toBe(415);
    // Signed in, with no code, a passkey cannot be added.
    const { browser: martin } = await signedIn();
    expect((await martin.post('/admin/enrol/options', {})).status).toBe(400);
    const answer = new Authenticator(ORIGIN, RP_ID).create({ challenge: 'c'.repeat(43) });
    expect((await martin.post('/admin/enrol', { response: answer, name: 'Phone' })).body.refused).toBe('challenge');
    expect(await db.owner`select 1 from passkeys where revoked_at is null`).toHaveLength(1);
  });

  it('holds Martin to two passkeys', async () => {
    await signedIn();
    await signedIn();
    const third = await enrolWith(new Browser(), new Authenticator(ORIGIN, RP_ID), await newCode());
    expect(third).toMatchObject({ status: 409, body: { refused: 'passkeys' } });
  });

  it('refuses a passkey made for another origin or relying party, or without user verification', async () => {
    for (const ceremony of [{ origin: 'https://evil.example' }, { rpId: 'evil.example' }, { verified: false }]) {
      const res = await enrolWith(new Browser(), new Authenticator(ORIGIN, RP_ID), await newCode(), ceremony);
      expect(res, JSON.stringify(ceremony)).toMatchObject({ status: 403, body: { refused: 'passkey' } });
    }
    expect(await db.owner`select 1 from passkeys where revoked_at is null`).toHaveLength(0);
  });
});

describe('signing in', () => {
  it('gives a new session id each time, ending the one it replaces', async () => {
    const { browser, passkey } = await signedIn();
    const before = browser.cookie;
    expect((await signIn(browser, passkey)).status).toBe(200);
    expect(browser.cookie).not.toBe(before);
    expect(
      await db.owner<{ ended_by: string }[]>`select ended_by from sessions where id_sha256 = ${sha256(before ?? '')}`,
    ).toEqual([{ ended_by: 'sign-out' }]);
    const old = new Browser();
    old.cookie = before;
    expect((await old.get('/admin/session')).status).toBe(401);
    expect((await browser.get('/admin/session')).status).toBe(200);
    expect((await lastEvents(1))[0]?.type).toBe('admin.signed-in');
  });

  it('uses each challenge once', async () => {
    const { browser, passkey } = await signedIn();
    const options = await browser.post('/admin/sign-in/options');
    const answer = passkey.get(options.body as { challenge: string });
    expect((await browser.post('/admin/sign-in', { response: answer })).status).toBe(200);
    expect(await browser.post('/admin/sign-in', { response: answer })).toMatchObject({
      status: 403,
      body: { refused: 'challenge' },
    });
    // Nor one the service never made.
    const made = passkey.get({ challenge: 'd'.repeat(43) });
    expect((await browser.post('/admin/sign-in', { response: made })).body.refused).toBe('challenge');
  });

  it('refuses an assertion for another origin or relying party, or without user verification', async () => {
    const { passkey } = await signedIn();
    for (const ceremony of [{ origin: 'https://evil.example' }, { rpId: 'evil.example' }, { verified: false }]) {
      const res = await signIn(new Browser(), passkey, ceremony);
      expect(res, JSON.stringify(ceremony)).toMatchObject({ status: 403, body: { refused: 'passkey' } });
    }
    expect((await signIn(new Browser(), passkey)).status).toBe(200);
  });

  it('refuses a passkey it never enrolled, or one revoked, and a request from anywhere but the console', async () => {
    expect((await signIn(new Browser(), new Authenticator(ORIGIN, RP_ID))).body.refused).toBe('passkey');
    const { passkey } = await signedIn();
    expect((await new Browser().post('/admin/sign-in/options', {}, { origin: 'https://evil.example' })).status).toBe(
      403,
    );
    await enrol(db.enrol, { revokeOthers: true });
    expect((await signIn(new Browser(), passkey)).body.refused).toBe('passkey');
  });
});

/** Each write route the service serves, with a body it takes. */
const WRITES: [string, Body][] = [
  ['/admin/sign-out', {}],
  ['/admin/sign-out-everywhere', {}],
  ['/admin/step-up/options', {}],
  ['/admin/step-up', {}],
  ['/admin/passkeys/whichever-passkey/revoke', {}],
];

describe('every write route', () => {
  it('is in the table as a write that takes a session, and refuses one by GET', async () => {
    for (const [path] of WRITES) {
      const route = routeOf('admin', 'POST', path);
      expect(route && ACCESS[route.name]).toMatchObject({ role: 'admin', does: 'write' });
      expect(routeOf('admin', 'GET', path), path).toBeNull();
    }
  });

  it('refuses no session, an expired one, a revoked one and one signed out', async () => {
    const expect401 = async (browser: Browser, why: string) => {
      for (const [path, body] of WRITES) {
        const res = await browser.post(path, body);
        expect(res, `${why}: ${path}`).toMatchObject({ status: 401, body: { refused: 'session' } });
      }
    };
    await expect401(new Browser(), 'no session');

    const expired = (await signedIn()).browser;
    await expire(expired);
    await expect401(expired, 'expired');

    const revoked = (await signedIn()).browser;
    await enrol(db.enrol, { revokeOthers: true });
    await expect401(revoked, 'revoked');

    const out = (await signedIn()).browser;
    const token = out.token;
    const cookie = out.cookie;
    expect((await out.post('/admin/sign-out')).status).toBe(200);
    out.cookie = cookie;
    out.token = token;
    await expect401(out, 'signed out');
  });

  it('refuses the wrong origin, no origin, a missing token and another session’s token', async () => {
    const { browser } = await signedIn();
    const other = (await signedIn()).browser;
    for (const [path, body] of WRITES) {
      expect((await browser.post(path, body, { origin: 'https://evil.example' })).body.refused, path).toBe('origin');
      expect((await browser.post(path, body, { origin: 'http://console.localhost:8443' })).body.refused, path).toBe(
        'origin',
      );
      expect((await browser.post(path, body, { origin: '' })).body.refused, path).toBe('origin');
      expect((await browser.post(path, body, { token: '' })).body.refused, path).toBe('token');
      expect((await browser.post(path, body, { token: other.token })).body.refused, path).toBe('token');
    }
    // Nothing was done: both are still signed in.
    expect((await browser.get('/admin/session')).status).toBe(200);
    expect((await other.get('/admin/session')).status).toBe(200);
  });
});

describe('the passkey given again', () => {
  const live = (steppedUp: boolean): Session => ({
    hash: 'h',
    passkey: { id: 'p', name: 'Laptop', transports: [] },
    signedInAt: new Date(),
    expiresAt: new Date(),
    steppedUpAt: steppedUp ? new Date() : null,
    steppedUp,
  });

  it('is needed by every action the table marks, and by none it does not', () => {
    const id = 'i'.repeat(43);
    const given = { origin: ORIGIN, token: tokenOf(id), id };
    const marked = (Object.entries(ACCESS) as [Name, Access][]).filter(([, access]) => access.stepUp);
    expect(marked.length).toBeGreaterThan(10);
    for (const [name, access] of marked) {
      expect(refuseWrite(access, given, live(false), ORIGIN)?.refused, name).toBe('step-up');
      expect(refuseWrite(access, given, live(true), ORIGIN), name).toBeUndefined();
    }
    for (const [name, access] of Object.entries(ACCESS) as [Name, Access][]) {
      if (access.stepUp || access.does !== 'write') continue;
      expect(refuseWrite(access, given, live(false), ORIGIN), name).toBeUndefined();
    }
  });

  it('is asked for by revoking a passkey, and lasts five minutes', async () => {
    const { browser, passkey } = await signedIn();
    const phone = await signedIn();
    const revoke = `/admin/passkeys/${phone.passkey.credentialId}/revoke`;
    expect(await browser.post(revoke)).toMatchObject({ status: 403, body: { refused: 'step-up' } });

    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect((await browser.get('/admin/session')).body.steppedUp).toBe(true);
    await db.owner`
      update sessions set stepped_up_at = now() - make_interval(mins => ${STEP_UP.minutes + 1})
      where id_sha256 = ${sessionOf(browser)}`;
    expect(await browser.post(revoke)).toMatchObject({ status: 403, body: { refused: 'step-up' } });

    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect(await browser.post(revoke)).toMatchObject({ status: 200, body: { revoked: true, signedOut: false } });
    // The phone's session ended with its passkey.
    expect((await phone.browser.get('/admin/session')).status).toBe(401);
    const [revoked] = await lastEvents(1);
    expect(revoked).toMatchObject({ type: 'passkey.revoked', payload: { passkey: 'Laptop', from: 'console' } });
    expect(revoked?.public).toMatchObject({ summary: 'Martin revoked a passkey', payload: { from: 'console' } });
    expect(JSON.stringify(revoked?.public)).not.toContain('Laptop');
  });

  it('is only the session’s own passkey, given for its own challenge', async () => {
    const { browser, passkey } = await signedIn();
    const phone = await signedIn();
    const options = await browser.post('/admin/step-up/options');
    const theirs = phone.passkey.get(options.body as { challenge: string });
    expect((await browser.post('/admin/step-up', { response: theirs })).body.refused).toBe('passkey');
    // A challenge made for the phone's session is not this one's, whatever passkey answers it.
    const phones = await phone.browser.post('/admin/step-up/options');
    const crossed = passkey.get(phones.body as { challenge: string });
    expect((await browser.post('/admin/step-up', { response: crossed })).body.refused).toBe('challenge');
    expect((await browser.get('/admin/session')).body.steppedUp).toBe(false);
  });
});

describe('signing out', () => {
  it('ends the session on the server, and clears the cookie', async () => {
    const { browser } = await signedIn();
    const cookie = browser.cookie;
    expect(await browser.post('/admin/sign-out')).toMatchObject({ status: 200, body: { signedOut: 'here' } });
    expect(browser.setCookie).toBe(`${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
    expect(await db.owner`select ended_by from sessions where id_sha256 = ${sha256(cookie ?? '')}`).toEqual([
      { ended_by: 'sign-out' },
    ]);
    expect((await lastEvents(1))[0]).toMatchObject({ type: 'admin.signed-out', payload: { everywhere: false } });
  });

  it('everywhere ends every session', async () => {
    const laptop = await signedIn();
    const phone = await signedIn();
    expect((await laptop.browser.post('/admin/sign-out-everywhere')).body).toEqual({ signedOut: 'everywhere' });
    expect((await phone.browser.get('/admin/session')).status).toBe(401);
    expect(await db.owner`select 1 from sessions where ended_at is null`).toHaveLength(0);
    expect((await lastEvents(1))[0]).toMatchObject({ type: 'admin.signed-out', payload: { everywhere: true } });
  });
});

/** Opens the full-event stream, and reads it until it closes or `until` is seen. */
async function openStream(browser: Browser) {
  const res = await fetch(`${base}/admin/events/stream`, {
    headers: browser.cookie ? { cookie: `${COOKIE}=${browser.cookie}` } : {},
  });
  const reader = res.body?.getReader();
  let text = '';
  const read = async (until: string, ms = 5000): Promise<{ text: string; closed: boolean }> => {
    const deadline = Date.now() + ms;
    while (!text.includes(until)) {
      if (Date.now() > deadline) throw new Error(`no ${until} in ${text}`);
      const chunk = await reader?.read();
      if (!chunk || chunk.done) return { text, closed: true };
      text += new TextDecoder().decode(chunk.value);
    }
    return { text, closed: false };
  };
  const closed = async () => {
    for (;;) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) return text;
      text += new TextDecoder().decode(chunk.value);
    }
  };
  return { res, read, closed, cancel: () => reader?.cancel() };
}

describe('the full-event stream', () => {
  it('sends a signed-in session the full events, and nobody else anything', async () => {
    expect((await openStream(new Browser())).res.status).toBe(401);
    const { browser } = await signedIn();
    const stream = await openStream(browser);
    expect(stream.res.status).toBe(200);
    expect(stream.res.headers.get('cache-control')).toBe('no-store, no-transform');
    // The full events: the passkey's name, which no public view carries.
    const { text } = await stream.read('"passkey":"Laptop"');
    expect(text).toContain('"type":"admin.signed-in"');
    await stream.cancel();
  });

  it('closes when the session signs out, everywhere, or its passkey is revoked', async () => {
    const { browser, passkey } = await signedIn();
    const phone = await signedIn();

    const mine = await openStream(browser);
    await mine.read('admin.signed-in');
    await browser.post('/admin/sign-out');
    expect(await mine.closed()).toContain('event: ended\ndata: {"why":"signed-out"}');

    expect((await signIn(browser, passkey)).status).toBe(200);
    const theirs = await openStream(phone.browser);
    await theirs.read('admin.signed-in');
    expect((await stepUp(browser, passkey)).status).toBe(200);
    await browser.post(`/admin/passkeys/${phone.passkey.credentialId}/revoke`);
    expect(await theirs.closed()).toContain('"why":"revoked"');

    const again = await openStream(browser);
    await again.read('admin.signed-in');
    await browser.post('/admin/sign-out-everywhere');
    expect(await again.closed()).toContain('"why":"signed-out"');
    expect(service.events.open).toBe(0);
  });

  it('closes when the session expires, or the command line revokes it, at its next check', async () => {
    const first = await signedIn();
    const stream = await openStream(first.browser);
    await stream.read('admin.signed-in');
    await expire(first.browser);
    expect(await stream.closed()).toContain('"why":"ended"');

    const second = await signedIn();
    const other = await openStream(second.browser);
    await other.read('admin.signed-in');
    await enrol(db.enrol, { revokeOthers: true });
    expect(await other.closed()).toContain('"why":"ended"');
  });
});

describe('forwarded headers', () => {
  const tries = async (forwardedFor: (i: number) => string) => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const res = await new Browser().post(
        '/admin/sign-in/options',
        {},
        { headers: { 'x-forwarded-for': forwardedFor(i) } },
      );
      statuses.push(res.status);
    }
    return statuses;
  };

  it('are ignored from anywhere but the proxy in front: the limit counts the connection', async () => {
    const statuses = await tries((i) => `203.0.113.${i}`);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it('are believed from the proxy, for the address it saw', async () => {
    await service.stop();
    await start({ trusted: proxies('127.0.0.1, ::1') });
    // Each from an address of its own, as the proxy says: none is limited.
    expect((await tries((i) => `203.0.113.${i}`)).every((s) => s === 200)).toBe(true);
    // What the client wrote to the left of the proxy's own entry is not believed.
    const spoofed = await tries((i) => `198.51.100.${i}, 192.0.2.1`);
    expect(spoofed[30]).toBe(429);
  });
});

describe('factory admin enrol', () => {
  it('prints a code of 128 random bits, which the store keeps the hash of', async () => {
    const made = await enrol(db.enrol);
    expect(made.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
    expect(
      await db.owner`select 1 from enrolment_codes where code_sha256 = ${sha256(made.code.replaceAll('-', ''))}`,
    ).toHaveLength(1);
    expect(described(made)).toContain(made.code);
    expect(described(made)).toContain(`in ${ENROLMENT_CODE.minutes} minutes`);
  });

  it('with --revoke-others, revokes every passkey and ends every session, recording each', async () => {
    const { browser } = await signedIn();
    await signedIn();
    const made = await enrol(db.enrol, { revokeOthers: true });
    expect(made.revoked).toEqual(['Laptop', 'Laptop']);
    expect(made.held).toEqual([]);
    expect((await browser.get('/admin/session')).status).toBe(401);
    expect(await db.owner`select 1 from sessions where ended_at is null`).toHaveLength(0);
    const revoked = await lastEvents(2);
    for (const event of revoked) {
      expect(event).toMatchObject({ type: 'passkey.revoked', actor: 'martin', payload: { from: 'command-line' } });
    }
    // The console shows them: the enrolment's role is Martin's.
    expect(await db.reader`select 1 from events where type = 'passkey.revoked'`).not.toHaveLength(0);
  });
});
