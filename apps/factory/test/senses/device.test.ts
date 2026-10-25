/**
 * The preview cookie's contract (docs/COMPONENTS/FEATURE-FLAGS.md), as the `/device` check holds a cookie to it. The
 * browser reads it as `probes.test.ts` shows, in the pinned Playwright image; this is each attribute it checks.
 */
import type { Cookie } from 'playwright';
import { describe, expect, it } from 'vitest';
import { PREVIEW_COOKIE, previewCookieFaults } from '../../src/senses/device.ts';

const NOW = 1_793_001_600;
const APP = 'http://website.website';

/** The cookie the app sets for `?preview=dark-mode`, as Playwright reads it a minute later. */
const COOKIE: Cookie = {
  name: 'preview',
  value: 'dark-mode',
  domain: 'website.website',
  path: '/',
  expires: NOW + 86_400 - 60,
  httpOnly: true,
  secure: false,
  sameSite: 'Lax',
};

const faults = (changes: Partial<Cookie>, app = APP, previewed = ['dark-mode', 'big-buttons']) =>
  previewCookieFaults({ ...COOKIE, ...changes }, { app, previewed: new Set(previewed) }, NOW);

describe('the preview cookie', () => {
  it('keeps to its contract as the app sets it, for one flag or several asked for', () => {
    expect(PREVIEW_COOKIE.name).toBe(COOKIE.name);
    expect(faults({})).toEqual([]);
    expect(faults({ value: 'dark-mode.big-buttons' })).toEqual([]);
    // A second's rounding is not a day and a bit.
    expect(faults({ expires: NOW + 86_401 })).toEqual([]);
  });

  it('is Secure exactly when the app is served over HTTPS', () => {
    expect(faults({ secure: true })).toEqual(['Secure on plain HTTP']);
    expect(faults({ domain: 'shop.example' }, 'https://shop.example')).toEqual(['not Secure on HTTPS']);
    expect(faults({ domain: 'shop.example', secure: true }, 'https://shop.example')).toEqual([]);
  });

  it('is for the app’s host alone, at the root, out of a script’s reach, and Lax', () => {
    expect(faults({ domain: '.website' })).toEqual(['for .website, not website.website alone']);
    expect(faults({ domain: '.website.website' })).toEqual(['for .website.website, not website.website alone']);
    expect(faults({ path: '/products' })).toEqual(['on the path /products, not /']);
    expect(faults({ httpOnly: false })).toEqual(['readable by a script']);
    expect(faults({ sameSite: 'None' })).toEqual(['SameSite=None, not Lax']);
    expect(faults({ sameSite: 'Strict' })).toEqual(['SameSite=Strict, not Lax']);
  });

  it('lasts a day at most, and never until the browser decides', () => {
    expect(faults({ expires: -1 })).toEqual(['with no Max-Age']);
    expect(faults({ expires: NOW + 7 * 86_400 })).toEqual(['lasting 168 hours, longer than a day']);
  });

  it('names flags that were asked for, each once, and nothing else', () => {
    expect(faults({ value: 'dark-mode' }, APP, [])).toEqual(['naming dark-mode, which was not asked for']);
    expect(faults({ value: 'dark-mode.dark-mode' })).toEqual(['naming a flag twice']);
    expect(faults({ value: '' })).toEqual(['not a list of flag names']);
    expect(faults({ value: 'dark-mode.visitor-4f2a' })).toEqual(['naming visitor-4f2a, which was not asked for']);
    expect(faults({ value: 'Dark_Mode' })).toEqual(['not a list of flag names']);
    expect(faults({ value: 'dark-mode,big-buttons' })).toEqual(['not a list of flag names']);
  });
});
