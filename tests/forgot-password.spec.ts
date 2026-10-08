import { test, expect } from '@playwright/test';
import { BASE_URL, openLoginScreen, selectPasswordMode } from './helpers/login';
import { readYopmailOtp } from './helpers/yopmail';

/**
 * Forgot-password flow (Ekshamata web).
 * ─────────────────────────────────────
 * From the login screen: Forgot Password → enter the account email → submit →
 * read the OTP that lands in the account's Yopmail inbox → enter it → set a new
 * password on the Keycloak "update password" screen the reset hands off to.
 *
 * Built from a Playwright codegen recording against staging, cleaned up so it
 * actually runs on its own:
 *   - the OTP is READ LIVE from Yopmail, not hard-coded (it changes every run);
 *   - Yopmail is opened directly, not via a Google search (which tripped a
 *     CAPTCHA in the recording);
 *   - the Keycloak hand-off is reached by following the redirect, not by a
 *     goto() of a recorded URL whose one-time tab_id/execution token is stale
 *     the moment the recording ends.
 *
 * Parameters (all optional — sensible defaults for a staging dry run):
 *   BASE_URL              which environment (default staging via helpers/login)
 *   FORGOT_EMAIL          the @yopmail.com account to reset
 *   FORGOT_NEW_PASSWORD   the password to set (default Sunbird@123)
 *
 *   npm run test:forgot
 */
const EMAIL = process.env.FORGOT_EMAIL || 'STAGE-BNRC-ANM045@yopmail.com';
const NEW_PASSWORD = process.env.FORGOT_NEW_PASSWORD || 'Sunbird@123';

test.describe('Ekshamata web — forgot password', () => {
  // Reading the OTP from a mailbox depends on the mail actually arriving, so
  // give the whole flow room beyond the default per-test timeout.
  test.setTimeout(180_000);

  test('resets the password via an emailed OTP', async ({ page, context }) => {
    expect(EMAIL, 'FORGOT_EMAIL must be a @yopmail.com address so the OTP can be read')
      .toMatch(/@yopmail\.com$/i);

    // ── 1. open the login screen and switch to password mode ──
    await openLoginScreen(page);
    await selectPasswordMode(page);

    // ── 2. start the reset and enter the account email ──
    await page.getByRole('link', { name: /forgot password/i }).click();
    const idField = page
      .getByRole('textbox', { name: /email id\s*\/\s*mobile number/i })
      .or(page.locator('#emailOrMobile'))
      .first();
    await idField.waitFor({ state: 'visible', timeout: 15_000 });
    await idField.fill(EMAIL);
    await page.getByRole('button', { name: /^submit$/i }).click();

    // ── 3. did the reset advance to the OTP screen, or did it error? ──
    // The portal can refuse the reset outright ("Sorry! There is some issue in
    // resetting your account. Please contact admin.") and STAY on the form — no
    // OTP is sent. Wait for whichever appears first and fail fast on the error,
    // rather than timing out 20s later on an OTP field that will never show AND
    // chasing a stale OTP left in the inbox from a previous attempt.
    const otpField = page.getByRole('textbox', { name: /enter otp/i }).first();
    const resetError = page
      .getByText(/issue in resetting your account|please contact admin|not registered|does not exist/i)
      .first();
    await expect(otpField.or(resetError)).toBeVisible({ timeout: 20_000 });
    if (await resetError.isVisible().catch(() => false)) {
      const msg = (await resetError.textContent().catch(() => ''))?.trim() || 'reset refused by the portal';
      throw new Error(
        `Password reset refused for ${EMAIL} on ${new URL(BASE_URL).hostname}: "${msg}". ` +
          `The account cannot be reset via email OTP on this environment — not a script fault.`,
      );
    }

    // ── 4. only now read the OTP — the reset genuinely advanced ──
    // Read AFTER the OTP screen is confirmed so a leftover OTP in the inbox is
    // not mistaken for this attempt's code.
    const otp = await readYopmailOtp(context, EMAIL, { attempts: 15, intervalMs: 5000 });
    console.log(`[forgot] OTP read from ${EMAIL}: ${otp}`);

    await otpField.fill(otp);
    await page.getByRole('button', { name: /reset password/i }).click();

    // ── 5. set the new password on the Keycloak update-password screen ──
    // The reset hands off to portal Keycloak (UPDATE_PASSWORD). Wait for its
    // fields to appear via the redirect — do NOT navigate to a recorded URL,
    // whose execution/tab_id token is single-use and already spent.
    const newPwd = page.getByRole('textbox', { name: /new password/i }).first();
    const confirmPwd = page.getByRole('textbox', { name: /confirm password/i }).first();
    await newPwd.waitFor({ state: 'visible', timeout: 30_000 });
    await newPwd.fill(NEW_PASSWORD);
    await confirmPwd.fill(NEW_PASSWORD);
    await page.getByRole('button', { name: /set password/i }).click();

    // ── 6. the reset landed us back at the app ──
    const backLink = page.getByRole('link', { name: /back to aastrika sphere/i });
    await expect(backLink).toBeVisible({ timeout: 30_000 });
    console.log('[forgot] password reset complete — back-to-app link shown');
  });
});
