import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL ?? 'https://ekshamata.aastrika.org';

/**
 * Smoke test: confirm the Ekshamata web portal loads its home page and exposes
 * the login entry point. Mirrors the mobile smoke test (which just confirms the
 * app launches and a WebView attaches) — here the "WebView" is the browser tab.
 */
test.describe('Ekshamata web smoke', () => {
  test('home page loads and shows a login entry', async ({ page }) => {
    await page.goto(`${BASE_URL}/page/home`);
    await page.waitForLoadState('networkidle').catch(() => {});

    console.log('Home URL:', page.url());
    console.log('Title:', await page.title());

    // The app shell should render *something* (Angular/Ionic root).
    await expect(page.locator('body')).toBeVisible();

    const loginEntry = page
      .locator('button.lg-btn')
      .or(page.getByRole('button', { name: /log\s?in|sign\s?in/i }))
      .first();
    await expect(loginEntry).toBeVisible({ timeout: 20_000 });
  });
});
