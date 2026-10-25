import { expect, type Locator, type Page, test } from '@playwright/test';
import { mockApi, photo } from './mock';

function fileRow(page: Page, name: string): Locator {
  return page.locator('#file-list li', { hasText: name });
}

test('picks files, uploads them through one session and says thanks', async ({ page }) => {
  const api = await mockApi(page);
  await page.goto('/e/e2e');
  await expect(page.locator('#event-name')).toHaveText('E2E Party');
  await page.fill('#guest-name', 'Sam');
  await page.locator('#guest-name').blur();

  await page.setInputFiles('#files', [photo('one.jpg'), photo('two.jpg'), photo('clip.mov', '')]);

  for (const name of ['one.jpg', 'two.jpg', 'clip.mov']) {
    await expect(fileRow(page, name).locator('.state')).toHaveText('uploaded ✓');
  }
  await expect(page.locator('#summary-text')).toHaveText('3 of 3 uploaded');
  await expect(page.locator('#thanks')).toBeVisible();
  await expect(page.locator('#thanks')).toContainText('All 3 uploaded.');
  await expect(page.locator('#keep-open')).toBeHidden();
  await expect(page.locator('#retry-failed')).toBeHidden();

  // One session shared by all three uploads (created concurrently), with the Turnstile token.
  expect(api.sessionBodies).toEqual([{ eventToken: 'e2e', turnstileToken: 'e2e-turnstile-token' }]);
  expect(api.presignBodies).toHaveLength(3);
  // An empty File.type falls back to the extension (some Android browsers do this).
  expect(api.presignBodies).toContainEqual(
    expect.objectContaining({ filename: 'clip.mov', contentType: 'video/quicktime' }),
  );
  expect(api.presignBodies.every((b) => b.guestName === 'Sam')).toBe(true);

  // The name is remembered for next time.
  await page.reload();
  await expect(page.locator('#guest-name')).toHaveValue('Sam');
});

test('refuses files that are not photos or videos without asking the API', async ({ page }) => {
  const api = await mockApi(page);
  await page.goto('/e/e2e');

  await page.setInputFiles('#files', [
    photo('notes.txt', 'text/plain'),
    photo('beach.png', 'image/png'),
  ]);

  await expect(fileRow(page, 'notes.txt').locator('.state')).toHaveText('not a photo or video');
  await expect(fileRow(page, 'beach.png').locator('.state')).toHaveText('uploaded ✓');
  await expect(page.locator('#summary-text')).toHaveText('1 of 2 uploaded · 1 failed');
  // Nothing to retry: the only failure can't succeed.
  await expect(page.locator('#retry-failed')).toBeHidden();
  expect(api.presignBodies.map((b) => b.filename)).toEqual(['beach.png']);
});

test('uploads RAW photos whose File.type is empty, declared by extension', async ({ page }) => {
  const api = await mockApi(page);
  await page.goto('/e/e2e');

  await page.setInputFiles('#files', [photo('IMG_0001.DNG', ''), photo('_MG_0002.CR3', '')]);

  for (const name of ['IMG_0001.DNG', '_MG_0002.CR3']) {
    await expect(fileRow(page, name).locator('.state')).toHaveText('uploaded ✓');
  }
  expect(api.presignBodies).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ filename: 'IMG_0001.DNG', contentType: 'image/x-adobe-dng' }),
      expect.objectContaining({ filename: '_MG_0002.CR3', contentType: 'image/x-canon-cr3' }),
    ]),
  );
});

test('offers only photos and videos on Android, so Chrome opens the photo picker', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/e/e2e');
  // The project emulates a Pixel 7, whose user agent says Android.
  await expect(page.locator('#files')).toHaveAttribute('accept', 'image/*,video/*');
  await expect(page.locator('input[type=file]')).toHaveCount(1);
});

test('truncates a long file name instead of widening its tile past the screen', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/e/e2e');

  const name = 'PXL_20261022_051542751.RAW-02.ORIGINAL.dng';
  await page.setInputFiles('#files', [photo(name, '')]);
  const row = fileRow(page, name);
  await expect(row.locator('.state')).toHaveText('uploaded ✓');

  const list = await page.locator('#file-list').boundingBox();
  const tile = await row.boundingBox();
  const state = await row.locator('.state').boundingBox();
  const viewport = page.viewportSize();
  expect(list && tile && state && viewport).toBeTruthy();
  if (!list || !tile || !state || !viewport) return;
  expect(tile.x + tile.width).toBeLessThanOrEqual(list.x + list.width + 0.5);
  expect(state.x + state.width).toBeLessThanOrEqual(tile.x + tile.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    viewport.width,
  );
});

test('skips a photo the guest already uploaded, in the same pick and after a reload', async ({
  page,
}) => {
  const api = await mockApi(page);
  await page.goto('/e/e2e');
  await page.fill('#guest-name', 'Sam');
  await page.locator('#guest-name').blur(); // saves the name, so it's still "Sam" after the reload

  await page.setInputFiles('#files', [photo('one.jpg'), photo('one.jpg')]);
  await expect(page.locator('#summary-text')).toHaveText('1 of 1 uploaded · 1 already uploaded');
  await expect(page.locator('#file-list .file.skipped .state')).toHaveText('already uploaded');

  await page.reload();
  await page.setInputFiles('#files', [photo('one.jpg'), photo('two.jpg')]);
  await expect(fileRow(page, 'two.jpg').locator('.state')).toHaveText('uploaded ✓');
  await expect(fileRow(page, 'one.jpg').locator('.state')).toHaveText('already uploaded');
  await expect(page.locator('#summary-text')).toHaveText('1 of 1 uploaded · 1 already uploaded');
  expect(api.presignBodies.map((b) => b.filename)).toEqual(['one.jpg', 'two.jpg']);
});

test('uploads the same photo again under a different guest name', async ({ page }) => {
  const api = await mockApi(page);
  await page.goto('/e/e2e');
  await page.fill('#guest-name', 'Sam');
  await page.setInputFiles('#files', [photo('one.jpg')]);
  await expect(fileRow(page, 'one.jpg').locator('.state')).toHaveText('uploaded ✓');

  await page.fill('#guest-name', 'Alex');
  await page.setInputFiles('#files', [photo('one.jpg')]);
  await expect(page.locator('#summary-text')).toHaveText('2 of 2 uploaded');
  expect(api.presignBodies.map((b) => b.guestName)).toEqual(['Sam', 'Alex']);
});

test('retries a transient S3 failure on its own', async ({ page }) => {
  const api = await mockApi(page);
  api.s3Replies.push({ status: 503, code: 'SlowDown' });
  await page.goto('/e/e2e');

  await page.setInputFiles('#files', [photo('one.jpg')]);

  await expect(fileRow(page, 'one.jpg').locator('.state')).toHaveText('retrying (1/3)…');
  await expect(fileRow(page, 'one.jpg').locator('.state')).toHaveText('uploaded ✓');
  expect(api.presignBodies).toHaveLength(2); // a fresh presigned POST per attempt
});

test('a permanent failure shows "Retry failed", which re-uploads it', async ({ page }) => {
  const api = await mockApi(page);
  api.s3Replies.push({ status: 403, code: 'AccessDenied', message: 'Invalid according to Policy' });
  await page.goto('/e/e2e');

  await page.setInputFiles('#files', [photo('one.jpg')]);

  await expect(fileRow(page, 'one.jpg').locator('.state')).toHaveText(
    'upload rejected: AccessDenied',
  );
  await expect(page.locator('#summary-text')).toHaveText('0 of 1 uploaded · 1 failed');
  await expect(page.locator('#thanks')).toBeHidden();

  await page.click('#retry-failed');

  await expect(fileRow(page, 'one.jpg').locator('.state')).toHaveText('uploaded ✓');
  await expect(page.locator('#summary-text')).toHaveText('1 of 1 uploaded');
  await expect(page.locator('#retry-failed')).toBeHidden();
});

test('asks for the PIN before uploading and sends it with the session', async ({ page }) => {
  const api = await mockApi(page, { event: { requiresPin: true } });
  await page.goto('/e/e2e');
  await expect(page.locator('#pin-field')).toBeVisible();

  await page.setInputFiles('#files', [photo('one.jpg')]);
  await expect(page.locator('#pin')).toBeFocused();
  await expect(page.locator('#progress')).toBeHidden();
  expect(api.sessionBodies).toHaveLength(0);

  api.sessionError = 'wrong-pin';
  await page.fill('#pin', '000000');
  await page.setInputFiles('#files', [photo('one.jpg')]);
  await expect(fileRow(page, 'one.jpg').locator('.state')).toHaveText('wrong PIN, check your card');
  await expect(page.locator('#pin')).toBeFocused();

  api.sessionError = null;
  await page.fill('#pin', '123456');
  await page.click('#retry-failed');
  await expect(fileRow(page, 'one.jpg').locator('.state')).toHaveText('uploaded ✓');
  expect(api.sessionBodies.at(-1)).toMatchObject({ eventToken: 'e2e', pin: '123456' });
});

test('a closed event shows its name and a message instead of the uploader', async ({ page }) => {
  await mockApi(page, {
    event: { status: 'closed', display: { headline: 'Say cheese', accentColor: '#1a5fb4' } },
  });
  await page.goto('/e/e2e');

  await expect(page.locator('#blocked')).toHaveText(
    'Uploads for this event have closed. Thank you!',
  );
  await expect(page.locator('#event-name')).toHaveText('E2E Party');
  await expect(page.locator('#headline')).toHaveText('Say cheese');
  await expect(page.locator('#uploader')).toBeHidden();
});

test('paused uploads and unknown links are explained to the guest', async ({ page }) => {
  await mockApi(page, { event: { uploadsEnabled: false } });
  await page.goto('/e/e2e');
  await expect(page.locator('#blocked')).toHaveText(
    'Uploads are paused right now. Please try again later.',
  );

  await page.goto('/e/someone-elses-token');
  await expect(page.locator('#blocked')).toHaveText(
    'This link isn’t valid. Please scan the event’s QR code again.',
  );
  await expect(page.locator('#uploader')).toBeHidden();
});
