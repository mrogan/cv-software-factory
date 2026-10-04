import { describe, expect, it } from 'vitest';
import { firstPrice, type Walked, walkFailure } from '../../src/probes/site.ts';

describe('the price a page shows', () => {
  it.each([
    ['Lamp £12.00', '£12.00'],
    ['£12.00In stock', '£12.00'],
    ['£12.00, free delivery', '£12.00'],
    ['£12.00/kg', '£12.00'],
    ['Was £1,250.00 now £999.00', '£1,250.00'],
    ['Only £5.', '£5'],
    ['Sale: £-6.00', '£-6.00'],
  ])('in %j is %j', (text, price) => {
    expect(firstPrice(text)).toBe(price);
  });

  it('is the same amount for a negative price however it is written', () => {
    expect(firstPrice('-£6.00')).toBe('£-6.00');
    expect(firstPrice('-£6.00 off')).toBe(firstPrice('£-6.00 off'));
  });

  it('is nothing when there is no amount of money', () => {
    expect(firstPrice('Price on request £')).toBeNull();
    expect(firstPrice('No price here')).toBeNull();
  });
});

describe('a walk that met a page that was not a page', () => {
  const walked = (status: number): Walked => ({
    cards: [],
    pages: 1,
    failed: { path: '/products?page=2', status, evidence: [] },
  });

  it('is a server error on that page when it answered 5xx', () => {
    const finding = walkFailure(walked(503), 'the catalogue');
    expect(finding?.symptom).toBe('server-error');
    expect(finding?.message).toContain('/products?page=2');
  });

  it('is a broken link when it answered 4xx', () => {
    expect(walkFailure(walked(404), 'the catalogue')?.symptom).toBe('broken-link');
  });

  it('is nothing when the walk went well', () => {
    expect(walkFailure({ cards: [], pages: 1 }, 'the catalogue')).toBeNull();
  });
});
