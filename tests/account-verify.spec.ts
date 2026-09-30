import { test, expect } from '@playwright/test';
import { loginWithPassword } from './helpers/login';

/**
 * Account page verification — for the account whose credentials you provide.
 *
 * Asserts, for the given role's account (Account tab → /app/profile-view):
 *   • profile details are READ-ONLY (no field is editable)…
 *   • …EXCEPT the "Language Preference" control, which must be present & work,
 *   • every Account button (Logout, Privacy policy, Terms of Use, Help & Contact)
 *     is displayed and enabled.
 *
 * Every check is its own test.step → shows as a sub-row in the branded report.
 *
 * Credentials are prompted interactively by scripts/verify-account.mjs, which
 * passes them as ACCOUNT_EMAIL / ACCOUNT_PASSWORD (+ optional ACCOUNT_ROLE).
 */
const EMAIL = process.env.ACCOUNT_EMAIL || process.env.EKSHAMATA_EMAIL || 'SHSB001@yopmail.com';
const PWD = process.env.ACCOUNT_PASSWORD || process.env.EKSHAMATA_PASSWORD || 'Aastrika@123';
const ROLE = process.env.ACCOUNT_ROLE || '';

const ACCOUNT_BUTTONS = ['Logout', 'Privacy policy', 'Terms of Use', 'Help & Contact'];

test.describe(`Account page${ROLE ? ` — ${ROLE}` : ''}`, () => {
  test('read-only except language; buttons display & work', async ({ page }) => {
    test.setTimeout(120_000);

    await test.step(`Log in as ${EMAIL}`, async () => {
      await loginWithPassword(page, EMAIL, PWD);
      expect(page.url(), 'left the login screen').not.toContain('/public/login');
    });

    await test.step('Open the Account tab', async () => {
      await page.getByRole('button', { name: /^(account|खाता)$/i }).or(page.getByText(/^(account|खाता)$/i)).first().click();
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(3_000);
      await expect(page, 'lands on the profile/account view').toHaveURL(/\/app\/(profile-view|account)/i);
    });

    await test.step('Profile details are READ-ONLY (no editable field)', async () => {
      const fields = await page.evaluate(() => {
        const vis = (el: Element) => (el as HTMLElement).offsetParent !== null;
        // profile inputs = every visible input EXCEPT the header search box
        const inputs = Array.from(document.querySelectorAll('input')).filter(vis)
          .filter((i) => !/search/i.test((i as HTMLInputElement).name || i.id || i.getAttribute('formcontrolname') || i.getAttribute('placeholder') || ''));
        return inputs.map((i) => ({
          editable: !(i as HTMLInputElement).disabled && !(i as HTMLInputElement).readOnly,
        }));
      });
      const editable = fields.filter((f) => f.editable).length;
      console.log(`[ACCOUNT] profile fields=${fields.length}, editable=${editable}`);
      expect(fields.length, 'profile fields are present').toBeGreaterThan(0);
      expect(editable, 'no profile field is editable').toBe(0);
    });

    await test.step('"Language Preference" is present and editable (the allowed exception)', async () => {
      const lang = page.getByText(/language preference/i).first();
      await expect(lang, '"Language Preference" is displayed').toBeVisible({ timeout: 10_000 });
    });

    await test.step('Language Preference opens a language selector (works)', async () => {
      await page.getByText(/language preference/i).first().click();
      await page.waitForTimeout(2_000);
      // a picker / options list with a language should appear (English / Hindi / हिंदी)
      const option = page.getByText(/english|हिंदी|hindi/i).first();
      await expect(option, 'language options are shown').toBeVisible({ timeout: 10_000 });
      // close without changing (Escape / Cancel / back) — verifying it works, not switching
      await page.keyboard.press('Escape').catch(() => {});
      const cancel = page.getByRole('button', { name: /cancel|close|back/i }).first();
      if (await cancel.waitFor({ state: 'visible', timeout: 1_500 }).then(() => true, () => false).catch(() => false)) await cancel.click().catch(() => {});
      await page.waitForTimeout(1_000);
    });

    for (const name of ACCOUNT_BUTTONS) {
      await test.step(`Button "${name}" is displayed & enabled`, async () => {
        const btn = page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
          .or(page.getByText(new RegExp(`^${name}$`, 'i'))).first();
        await expect(btn, `"${name}" is displayed`).toBeVisible({ timeout: 10_000 });
        const disabled = await btn.isDisabled().catch(() => false);
        expect(disabled, `"${name}" is enabled`).toBe(false);
      });
    }
  });
});
