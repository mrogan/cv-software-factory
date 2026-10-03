import { describe, expect, it } from 'vitest';
import { templater } from '../../src/senses/routes.ts';

const PATHS = [
  '/',
  '/about',
  '/products',
  '/products/a',
  '/products/b?x=1',
  '/departments/home',
  '/departments/desk',
  '/departments/outdoors',
  '/assets/site.css',
  '/assets/report.js',
  '/assets/drawings/a.svg',
  '/assets/drawings/b.svg',
  '/team/ann',
];

describe('route templates', () => {
  const template = templater(PATHS);

  it('names the items of a collection by a parameter, as the probes do', () => {
    expect(template('/products/a')).toBe('/products/:slug');
    expect(template('/products/anything-else')).toBe('/products/:slug');
    expect(template('/departments/home')).toBe('/departments/:department');
  });

  it('puts the files of a folder under one route', () => {
    expect(template('/assets/drawings/a.svg')).toBe('/assets/drawings/:file');
    expect(template('/assets/site.css')).toBe('/assets/:file');
  });

  it('leaves other paths as they are, and never keeps a query', () => {
    expect(template('/')).toBe('/');
    expect(template('/about')).toBe('/about');
    expect(template('/team/ann')).toBe('/team/ann');
    expect(template('/products?page=2')).toBe('/products');
  });

  it('does not make a route of one lone file', () => {
    expect(templater(['/favicon.ico', '/'])('/favicon.ico')).toBe('/favicon.ico');
  });
});
