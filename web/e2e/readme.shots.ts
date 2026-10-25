/**
 * @fileoverview The README screenshots: a phone showing an open event, uploads in flight, and the
 * thanks.
 */
import { test, type Page } from '@playwright/test';
import { mockApi, photo, S3_URL } from './mock';

const OUT = new URL('../../docs/images', import.meta.url).pathname;

const event = {
  name: 'Pizza & Games Night',
  display: {
    headline: 'Share your photos',
    welcome: 'Add the photos and videos you took tonight. Full quality, no app, no account.',
    accentColor: '#1a5fb4',
  },
};

const files = [
  photo('IMG_2041.jpg'),
  photo('IMG_2042.jpg'),
  photo('IMG_2047.heic', 'image/heic'),
  photo('IMG_2051.mov', 'video/quicktime'),
  photo('IMG_2053.jpg'),
];

async function open(page: Page): Promise<void> {
  await mockApi(page, { token: 'demo', event });
  await page.route('**/api/health', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{"ok":true,"stage":"prod"}' }),
  );
  await page.goto('/e/demo');
  await page.locator('#event-name').waitFor();
  await page.fill('#guest-name', 'Alex');
  await page.locator('#guest-name').blur();
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme });

    test('open', async ({ page }) => {
      await open(page);
      // The empty page is short: keep the top half.
      await page.screenshot({
        path: `${OUT}/guest-open-${scheme}.png`,
        animations: 'disabled',
        clip: { x: 0, y: 0, width: 412, height: 420 },
      });
    });

    test('uploading', async ({ page }) => {
      await open(page);
      // The first two finish, the rest stay in flight for the picture.
      let replies = 0;
      await page.route(S3_URL, async (route) => {
        if (++replies <= 2) {
          return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
        }
        await new Promise(() => {});
      });
      await page.setInputFiles('#files', files);
      await page.locator('#summary-text').filter({ hasText: '2 of 5' }).waitFor();
      await page.screenshot({
        path: `${OUT}/guest-uploading-${scheme}.png`,
        animations: 'disabled',
      });
    });

    test('done', async ({ page }) => {
      await open(page);
      await page.setInputFiles('#files', files);
      await page.locator('#thanks').waitFor();
      await page.screenshot({ path: `${OUT}/guest-done-${scheme}.png`, animations: 'disabled' });
    });
  });
}
