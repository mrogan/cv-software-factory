import { describe, expect, it } from 'vitest';
import { aboutTheConnection } from '../../src/senses/browser.ts';

describe('what the browser says about the connection, not the page', () => {
  it('is not counted as the app’s error', () => {
    expect(
      aboutTheConnection(
        "The Cross-Origin-Opener-Policy header has been ignored, because the URL's origin was untrustworthy.",
      ),
    ).toBe(true);
  });

  it('leaves the page’s own errors alone', () => {
    expect(aboutTheConnection("Uncaught TypeError: Cannot set properties of null (setting 'textContent')")).toBe(false);
  });
});
