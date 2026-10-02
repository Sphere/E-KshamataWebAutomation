/**
 * Ekshamata web-portal login helper (Playwright).
 *
 * NOTE: This targets the real Ekshamata WEB app, which is an Angular-Material
 * UI (NOT the Ionic/Capacitor mobile DOM). Selectors verified live against
 * https://ekshamata.aastrika.org on 2026-07-15:
 *   - "Login" entry button        button.login-btn
 *   - "Login with Password" radio  input#usePasswordRB
 *   - login id field               input#emailOrMobile
 *   - password field               input[type="password"]
 *   - password submit button       button#login-username-password
 *
 * Routes: home /page/home (redirects to /public/home when logged out),
 * login /public/login, authenticated home /page/home.
 */
import { Page, expect } from '@playwright/test';

export const BASE_URL = process.env.BASE_URL ?? 'https://ekshamata.aastrika.org';

/**
 * Staging runs a different build: it does not carry the #emailOrMobile /
 * #login-username-password ids production uses. UAT (ekshamata-uat) runs that
 * same build — its login failed on the missing id until it was included here.
 * The looser selectors below are scoped to staging + UAT ONLY — on production
 * they could resolve to the wrong element (locator.or() picks the first match in
 * DOM ORDER, so a header search box would win over the login field), and
 * production works with its ids today.
 */
const IS_STAGING = /staging|(^|\/\/|-)uat\./i.test(BASE_URL);

/** True once we have left the /public/login screen (logged in or on a gate). */
const onLoginPage = (u: string) => /\/public\/login/.test(u);

/**
 * If the page lands on a post-login terms/consent gate, accept it.
 * Best-effort and non-fatal — a no-op for existing users who never see it.
 */
/**
 * Accept the Terms of use gate whenever it appears — new user or old.
 *
 * Detected by the gate's OWN BUTTONS (`accept-btn` / `decline-btn`), not by its
 * wording. The previous version looked for "Terms and conditions" while the page
 * actually says "Terms of use", so it decided the gate was not there and
 * returned without accepting; and the portal renders this screen in the
 * account's language, where Accept reads "स्वीकार करना".
 *
 * Accept stays DISABLED until the consent box is ticked, so the box is ticked
 * first and verified — a click that does not register would otherwise leave the
 * run pressing a dead button.
 *
 * Safe to call after every login: it returns false immediately when no gate is
 * on screen.
 */
export async function acceptTermsIfPresent(page: Page): Promise<boolean> {
  const acceptBtn = page.locator('button.accept-btn')
    .or(page.getByRole('button', { name: /^\s*(accept|agree|proceed|continue|submit)\s*$/i }))
    .or(page.getByRole('button', { name: /^\s*(स्वीकार|सहमत)/i }))
    .first();

  // Let the post-login redirect chain finish before deciding anything. Login
  // resolves the moment the URL stops being /public/login, which is BEFORE the
  // app has routed to the gate.
  await page.waitForLoadState('networkidle').catch(() => {});

  // waitFor, NOT isVisible: `isVisible()` is an INSTANT check and its `timeout`
  // option does not make it wait. Detection built on it answered "no gate" while
  // the SPA was still rendering one — which is precisely why a Terms screen a
  // human sees on staging was never accepted, and every fresh account then sat
  // on /app/new-tnc with an empty home behind it.
  const looksLikeTerms = /new-tnc|\/tnc\b|consent/i.test(page.url());
  const present = await acceptBtn
    .waitFor({ state: 'visible', timeout: looksLikeTerms ? 25_000 : 6_000 })
    .then(() => true)
    .catch(() => false);
  if (!present) return false;
  console.log('[tnc] Terms of use gate — accepting');

  // ── tick the consent box, and make sure it took ──
  const boxChecked = async () =>
    page.evaluate(() => {
      const input = document.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      const mat = document.querySelector('mat-checkbox, [role="checkbox"]');
      return Boolean(input?.checked) || mat?.getAttribute('aria-checked') === 'true'
        || Boolean(mat?.classList.contains('mat-mdc-checkbox-checked'));
    }).catch(() => false);

  for (let attempt = 1; attempt <= 3 && !(await boxChecked()); attempt++) {
    const targets = [
      page.locator('mat-checkbox.tnc-checkbox label, mat-checkbox label').first(),
      page.locator('mat-checkbox, [role="checkbox"]').first(),
      page.locator('input[type="checkbox"]').first(),
    ];
    for (const target of targets) {
      if (!(await target.isVisible({ timeout: 1_000 }).catch(() => false))) continue;
      await target.click({ force: attempt > 1 }).catch(() => {});
      await page.waitForTimeout(350);
      if (await boxChecked()) break;
    }
  }
  if (!(await boxChecked())) console.log('[tnc] the consent box would not tick — Accept may stay disabled');

  // ── accept ──
  await acceptBtn.scrollIntoViewIfNeeded().catch(() => {});
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (!(await acceptBtn.isDisabled().catch(() => false))) {
      await acceptBtn.click().catch(() => {});
      await page.waitForTimeout(1_200);
      break;
    }
    await page.waitForTimeout(700);
  }

  // ── did we actually leave? ──
  const left = await page
    .waitForFunction(() => !document.querySelector('button.accept-btn'), undefined, { timeout: 12_000 })
    .then(() => true).catch(() => false);
  await page.waitForLoadState('networkidle').catch(() => {});
  console.log(left ? '[tnc] accepted' : '[tnc] still on the Terms of use screen after accepting');
  return left;
}

/** Navigate to home and open the login screen (/public/login). */
export async function openLoginScreen(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/page/home`);
  await page.waitForLoadState('networkidle').catch(() => {});

  // Already on the login screen? Nothing to click.
  if (onLoginPage(page.url())) return;

  const loginEntry = page
    .locator('button.login-btn')
    .or(page.getByRole('button', { name: /^log\s?in$|^sign\s?in$/i }))
    .first();

  // A stale session (leftover cookies from a prior run) lands us on an
  // AUTHENTICATED home — so there's no "Login" button and we'd hang. Detect that
  // (no Login button shortly after load) and hard-reset the session so we log in
  // as the intended freshly-provisioned user, not whoever was left signed in.
  if (!(await loginEntry.isVisible({ timeout: 5_000 }).catch(() => false))) {
    await page.context().clearCookies();
    await page.goto(`${BASE_URL}/public/home`);
    await page.waitForLoadState('networkidle').catch(() => {});
    if (onLoginPage(page.url())) return;
  }

  await loginEntry.waitFor({ state: 'visible', timeout: 20_000 });
  await loginEntry.click();
  await page.waitForURL(/\/public\/login/, { timeout: 20_000 });
}

/** Switch the login form into "Login with Password" mode. */
export async function selectPasswordMode(page: Page): Promise<void> {
  const byPassword = page
    .locator('#usePasswordRB')
    .or(page.getByText(/login with password/i))
    .first();
  await byPassword.waitFor({ state: 'visible', timeout: 15_000 });
  await byPassword.click();
  // The password field appears once the form swaps to password mode.
  await page.locator('input[type="password"]').first().waitFor({ state: 'visible', timeout: 10_000 });
}

/**
 * Log an existing account in through the real Ekshamata web login UI by
 * password, clearing any post-login terms gate if it appears.
 */
export async function loginWithPassword(
  page: Page,
  identifier: string,
  password: string,
): Promise<void> {
  await openLoginScreen(page);
  await selectPasswordMode(page);

  const idField = IS_STAGING
    ? page.locator('#emailOrMobile')
        .or(page.getByRole('textbox', { name: /phone number|email|मोबाइल|ईमेल/i }))
        .or(page.getByPlaceholder(/phone number|email|मोबाइल|ईमेल/i))
        .first()
    : page.locator('#emailOrMobile').first();
  await idField.waitFor({ state: 'visible', timeout: 15_000 });
  await idField.fill(identifier);

  const pwdField = page.locator('input[type="password"]').first();
  await pwdField.waitFor({ state: 'visible', timeout: 15_000 });
  await pwdField.fill(password);

  const submitBtn = IS_STAGING
    ? page.locator('#login-username-password')
        .or(page.getByRole('button', { name: /^(log\s?in|sign\s?in|लॉगिन|लॉग\s?इन)$/i }))
        .first()
    : page.locator('#login-username-password').first();
  await expect(submitBtn).toBeEnabled({ timeout: 10_000 });
  await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
  await submitBtn.click();

  // Success = we leave /public/login (into home/dashboard or a terms gate).
  // NOTE: this lands on sphere.aastrika.org — the Ekshamata web build is
  // configured to hand off to the Sphere instance for the authenticated app.
  await page.waitForURL((u) => !onLoginPage(u.toString()), { timeout: 30_000 });
  await acceptTermsIfPresent(page);
  await page.waitForLoadState('networkidle').catch(() => {});
}
