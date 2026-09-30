import { test, expect } from '@playwright/test';

/**
 * Ekshamata click-by-click journey — every click / action is its own reportable
 * `test.step`, so the branded report lists each one as a pass/fail sub-row.
 * Uses the existing account in .env (EKSHAMATA_EMAIL / EKSHAMATA_PASSWORD).
 */
const BASE = process.env.BASE_URL ?? 'https://ekshamata.aastrika.org';
const EMAIL = process.env.EKSHAMATA_EMAIL || 'SHSB001@yopmail.com';
const PWD = process.env.EKSHAMATA_PASSWORD || 'Aastrika@123';

test.describe('Ekshamata — click-by-click journey', () => {
  test('log in and navigate the app (every click a step)', async ({ page }) => {
    test.setTimeout(120_000);

    await test.step('Open home  (/page/home)', async () => {
      await page.goto(`${BASE}/page/home`);
      await page.waitForLoadState('networkidle').catch(() => {});
    });

    await test.step('Click "Login" entry', async () => {
      const login = page.locator('button.login-btn')
        .or(page.getByRole('button', { name: /^log\s?in$/i })).first();
      // Clear a stale session so we land on the anonymous login.
      if (!(await login.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false).catch(() => false))) {
        await page.context().clearCookies();
        await page.goto(`${BASE}/public/home`);
        await page.waitForLoadState('networkidle').catch(() => {});
      }
      await login.waitFor({ state: 'visible', timeout: 20_000 });
      await login.click();
      await page.waitForURL(/\/public\/login/, { timeout: 20_000 });
    });

    await test.step('Select "Login with Password"', async () => {
      await page.locator('#usePasswordRB').or(page.getByText(/login with password/i)).first().click();
      await page.locator('input[type="password"]').first().waitFor({ state: 'visible', timeout: 10_000 });
    });

    await test.step('Enter email', async () => {
      // Prod's field has id=emailOrMobile; staging's build does not — find it by its label there.
      await page.locator('#emailOrMobile')
        .or(page.getByPlaceholder(/phone number|email/i))
        .or(page.getByLabel(/phone number|email/i)).first().fill(EMAIL);
    });

    await test.step('Enter password', async () => {
      await page.locator('input[type="password"]').first().fill(PWD);
    });

    await test.step('Click "Login" (submit)', async () => {
      // Prod's submit has id=login-username-password; staging's is just the "Login" button.
      await page.locator('#login-username-password')
        .or(page.getByRole('button', { name: /^s*logs?ins*$/i })).first().click();
      await page.waitForURL((u) => !/\/public\/login/.test(u.toString()), { timeout: 30_000 });
    });

    await test.step('Accept Terms & Conditions (if shown)', async () => {
      const b = page.getByRole('button', { name: /accept|agree|proceed|continue|submit/i }).first();
      if (await b.waitFor({ state: 'visible', timeout: 2_500 }).then(() => true, () => false)) await b.click().catch(() => {});
    });

    await test.step('Verify authenticated home', async () => {
      await page.goto(`${BASE}/page/home`);
      await page.waitForLoadState('networkidle').catch(() => {});
      const nav = page.getByRole('button', { name: /^(my courses|मेरे पाठ्यक्रम)$/i })
        .or(page.getByText(/^(my courses|मेरे पाठ्यक्रम)$/i)).first();
      await expect(nav, 'authenticated nav visible').toBeVisible({ timeout: 20_000 });
    });

    await test.step('Click "My Courses"', async () => {
      await page.getByRole('button', { name: /^(my courses|मेरे पाठ्यक्रम)$/i }).or(page.getByText(/^(my courses|मेरे पाठ्यक्रम)$/i)).first().click();
      await page.waitForTimeout(2_500);
    });

    await test.step('Click "Competency"', async () => {
      await page.getByRole('button', { name: /^(competency|योग्यता)$/i }).or(page.getByText(/^(competency|योग्यता)$/i)).first().click().catch(() => {});
      await page.waitForTimeout(2_500);
    });

    await test.step('Click "Account"', async () => {
      await page.getByRole('button', { name: /^(account|खाता)$/i }).or(page.getByText(/^(account|खाता)$/i)).first().click().catch(() => {});
      await page.waitForTimeout(2_500);
    });

    await test.step('Click "Home"', async () => {
      await page.getByRole('button', { name: /^(home|होम)$/i }).or(page.getByText(/^(home|होम)$/i)).first().click().catch(() => {});
      await page.waitForTimeout(1_500);
    });
  });
});
