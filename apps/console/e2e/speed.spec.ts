/**
 * First meaningful view within two seconds on a throttled phone: the line drawn from the factory's events. Against
 * the test server by default; CONSOLE_URL points it at the local cluster.
 */
import { consoleUrl, expect, test } from './support.ts';

const cluster = process.env.CONSOLE_URL;

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  ...(cluster && { baseURL: cluster }),
});

test('draws the first meaningful view within two seconds on a throttled phone', async ({ page, baseURL }) => {
  const cdp = await page.context().newCDPSession(page);
  // Lighthouse's mobile profile: a slow 4G network and a phone's CPU, four times slower than this one.
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  // The cluster shows the time as it is; the test server, the samples' last moment.
  await page.goto(cluster ? `${baseURL}/` : consoleUrl({ motion: true }));
  const firstView = await page.waitForFunction(() => performance.getEntriesByName('sf:first-view')[0]?.startTime);
  const ms = Number(await firstView.jsonValue());
  console.log(`First meaningful view after ${Math.round(ms)} ms`);
  expect(ms).toBeLessThan(2000);
});
