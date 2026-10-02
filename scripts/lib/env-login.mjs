/**
 * Log one Ekshamata environment in and hand back a storageState the comparison
 * run can reuse. Mirrors tests/helpers/login.ts — same entry button, same
 * "Login with Password" radio, same field ids, same staging fallbacks — but in
 * plain JS so the runner scripts need no TypeScript step.
 *
 * States are cached per host + account under .cache/, so a re-run does not log
 * in again (use --refresh to force a fresh login).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const STATE_TTL_MS = 6 * 60 * 60 * 1000; // a session lasts comfortably longer than a run
// How long after creation an account is treated as still being provisioned.
const SETTLE_MS = 5 * 60 * 1000;

const stateFile = (baseUrl, email) =>
  resolve(ROOT, '.cache', `state-${new URL(baseUrl).hostname}-${email.replace(/[^a-z0-9]/gi, '_')}.json`);

const onLoginPage = (u) => /\/public\/login/.test(u);

/** Accept the post-login terms/consent gate if it is showing. Non-fatal. */
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
async function acceptTermsIfPresent(page) {
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
      const input = document.querySelector('input[type="checkbox"]');
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

/**
 * Log in through the Ekshamata web UI by password.
 *
 * Staging runs a different build and does not carry production's
 * #emailOrMobile / #login-username-password ids, so the looser selectors are
 * used THERE ONLY — on production they could resolve to a header search box
 * instead of the login field (locator.or() picks the first match in DOM order).
 */
export async function loginWithPassword(page, baseUrl, email, password) {
  // Staging AND UAT run the login build without production's field ids.
  const isStaging = /staging|(^|\/\/|-)uat\./i.test(baseUrl);

  // ── open the login screen ──
  await page.goto(`${baseUrl}/page/home`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});

  if (!onLoginPage(page.url())) {
    const loginEntry = page
      .locator('button.login-btn')
      .or(page.getByRole('button', { name: /^log\s?in$|^sign\s?in$|^लॉगिन$/i }))
      .first();

    // Leftover cookies land us on an AUTHENTICATED home — there is no Login
    // button then, and we would hang. Reset and try the public home instead.
    if (!(await loginEntry.isVisible({ timeout: 5000 }).catch(() => false))) {
      await page.context().clearCookies();
      await page.goto(`${baseUrl}/public/home`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});
    }
    if (!onLoginPage(page.url())) {
      await loginEntry.waitFor({ state: 'visible', timeout: 20000 });
      await loginEntry.click();
      await page.waitForURL(/\/public\/login/, { timeout: 20000 });
    }
  }

  // ── switch to password mode ──
  const byPassword = page
    .locator('#usePasswordRB')
    .or(page.getByText(/login with password|पासवर्ड\s*से\s*लॉगिन/i))
    .first();
  await byPassword.waitFor({ state: 'visible', timeout: 15000 });
  await byPassword.click();
  await page.locator('input[type="password"]').first().waitFor({ state: 'visible', timeout: 10000 });

  // ── credentials ──
  const idField = isStaging
    ? page
        .locator('#emailOrMobile')
        .or(page.getByRole('textbox', { name: /phone number|email|मोबाइल|ईमेल/i }))
        .or(page.getByPlaceholder(/phone number|email|मोबाइल|ईमेल/i))
        .first()
    : page.locator('#emailOrMobile').first();
  await idField.waitFor({ state: 'visible', timeout: 15000 });
  await idField.fill(email);

  const pwdField = page.locator('input[type="password"]').first();
  await pwdField.fill(password);

  const submitBtn = isStaging
    ? page
        .locator('#login-username-password')
        .or(page.getByRole('button', { name: /^(log\s?in|sign\s?in|लॉगिन|लॉग\s?इन)$/i }))
        .first()
    : page.locator('#login-username-password').first();
  await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
  await submitBtn.click();

  // Success = we leave /public/login (into home, or a terms gate).
  await page.waitForURL((u) => !onLoginPage(u.toString()), { timeout: 30000 }).catch(() => {});
  await acceptTermsIfPresent(page);
  await page.waitForLoadState('networkidle').catch(() => {});

  if (onLoginPage(page.url())) {
    throw new Error(
      `login did not leave /public/login on ${new URL(baseUrl).hostname} ` +
        `(wrong credentials, or the account does not exist on this environment)`,
    );
  }
}

/**
 * A storageState for `baseUrl`, logging in only when the cached one is stale.
 *
 * @returns {Promise<{state: object, cached: boolean}>}
 */
export async function authState(browser, baseUrl, email, password, { refresh = false, maxAgeMs = STATE_TTL_MS, print = console.log } = {}) {
  const file = stateFile(baseUrl, email);
  if (!refresh && existsSync(file)) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf-8'));
      const ageMs = Date.now() - Date.parse(saved.savedAt);
      if (ageMs < maxAgeMs) {
        print(`   🔐 reusing the session saved ${Math.round(ageMs / 1000)}s ago for ${email} on ${new URL(baseUrl).hostname}`);
        return { state: saved.state, cached: true };
      }
    } catch (e) {
      /* fall through and log in again */
    }
  }

  print(`   🔐 logging in as ${email} on ${new URL(baseUrl).hostname} …`);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await loginWithPassword(page, baseUrl, email, password);
    const state = await context.storageState();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ savedAt: new Date().toISOString(), state }, null, 2));
    return { state, cached: false };
  } finally {
    await context.close().catch(() => {});
  }
}

// ── the provisioned-account ledger ────────────────────────────────────
// scripts/create-user-pair.mjs and the org suites append one line per account
// to created-users.txt:
//   <iso> | <ORG> | <designation> | <email> | <password> | userId=<uuid> | env=<host>
// last-created-user.json holds the most recent one as an object.

/** Production and staging are separate backends — accounts do not cross. */
const PROD_HOST = 'ekshamata.aastrika.org';

/**
 * Hosts that mean the same PORTAL.
 *
 * Production Ekshamata is served by the same backend as Sphere, so provisioning
 * runs on sphere.aastrika.org while the portal you log in to is
 * ekshamata.aastrika.org. Ledger lines written with the API host still describe
 * accounts that belong to production.
 */
const HOST_ALIASES = { 'sphere.aastrika.org': PROD_HOST };
const canonicalHost = (host) => HOST_ALIASES[host] || host;

/** Every account in created-users.txt, newest first. */
export function createdUsers() {
  const file = resolve(ROOT, 'created-users.txt');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split(/\r?\n/)
    .map((line) => line.split('|').map((s) => s.trim()))
    .filter((p) => p.length >= 5 && /@/.test(p[3]))
    .map(([createdAt, orgKey, designation, email, password, id, env]) => ({
      createdAt,
      orgKey,
      designation,
      email,
      password,
      userId: (id || '').replace(/^userId=/, ''),
      // Lines written before accounts were tagged carry no env. Every one of
      // those was made on production, so that is what they are treated as.
      env: canonicalHost((env || '').replace(/^env=/, '')) || PROD_HOST,
    }))
    .reverse();
}

/** The accounts that exist on ONE environment, newest first. */
export function createdUsersOn(baseUrl) {
  const host = canonicalHost(new URL(baseUrl).hostname);
  return createdUsers().filter((u) => u.env === host);
}

/** The newest created account, optionally narrowed to one org or one email. */
export function createdUser({ org = '', email = '', baseUrl = '' } = {}) {
  const list = baseUrl ? createdUsersOn(baseUrl) : createdUsers();
  if (email) return list.find((u) => u.email.toLowerCase() === email.toLowerCase()) || null;
  if (org) return list.find((u) => (u.orgKey || '').toLowerCase() === org.toLowerCase()) || null;
  return list[0] || null;
}

/** An account named outright in .env for this environment, or null. */
export function explicitCredentials(baseUrl) {
  const host = new URL(baseUrl).hostname;
  const prefix = /staging/i.test(host) ? 'STAGING' : /(^|-)uat\./i.test(host) ? 'UAT' : /^localhost|127\.0\.0\.1/.test(host) ? 'LOCAL' : 'PROD';
  const pairs = [
    [process.env[`${prefix}_EMAIL`], process.env[`${prefix}_PASSWORD`], `${prefix}_EMAIL`],
    [process.env.COMPARE_EMAIL, process.env.COMPARE_PASSWORD, 'COMPARE_EMAIL'],
  ];
  for (const [email, password, source] of pairs) {
    if (email && password) return { email, password, source };
  }
  return null;
}

/**
 * The accounts to try for one environment, best first:
 *   PROD_EMAIL / STAGING_EMAIL (per env)  →  COMPARE_EMAIL  →  the accounts
 *   created ON THAT ENVIRONMENT (--user / --org, else newest first)  →
 *   EKSHAMATA_EMAIL
 *
 * Only accounts made on this environment are offered. Production and staging
 * are separate backends, so a production account simply does not exist on
 * staging — offering it there produces a failed login that looks like a portal
 * fault instead of a missing account. Create the pair with:
 *   npm run create:pair -- <ORG>
 *
 * Several are returned because created-users.txt is a live ledger: the very
 * newest entry can be an account a provisioning run is still finishing, which
 * cannot log in yet. The caller signs in with the first one that actually works
 * rather than failing the whole comparison on a half-made account.
 *
 * An account named in .env is returned ALONE — an explicit choice is never
 * silently replaced by a different account.
 */
export function credentialCandidates(baseUrl, { user = '', org = '', limit = 6 } = {}) {
  const explicit = explicitCredentials(baseUrl);
  if (explicit) return [explicit];

  const host = new URL(baseUrl).hostname;
  const tag = (u) => {
    const bits = [u.orgKey, u.designation].filter(Boolean).join(' · ');
    return `created on ${u.env}${bits ? ` · ${bits}` : ''}`;
  };
  const here = createdUsersOn(baseUrl);

  if (user || org) {
    // An explicit pick: that one account (--user), or that org's accounts (--org).
    const list = user
      ? here.filter((u) => u.email.toLowerCase() === user.toLowerCase())
      : here.filter((u) => (u.orgKey || '').toLowerCase() === org.toLowerCase());
    return list.slice(0, user ? 1 : limit).map((u) => ({ email: u.email, password: u.password, source: tag(u) }));
  }

  const out = [];
  const seen = new Set();
  const push = (email, password, source) => {
    if (!email || !password || seen.has(email.toLowerCase())) return;
    seen.add(email.toLowerCase());
    out.push({ email, password, source });
  };

  // An account written to the ledger seconds ago may still be mid-provisioning
  // and cannot log in yet, so accounts that have SETTLED are preferred. The
  // very fresh ones stay in the list, just after them.
  const age = (u) => (u.createdAt ? Date.now() - Date.parse(u.createdAt) : Infinity);
  const settled = here.filter((u) => age(u) >= SETTLE_MS);
  const fresh = here.filter((u) => age(u) < SETTLE_MS);

  for (const u of [...settled, ...fresh].slice(0, limit)) push(u.email, u.password, tag(u));
  // The .env learner exists on BOTH backends, so it is a valid last resort
  // wherever we are pointed.
  push(process.env.EKSHAMATA_EMAIL, process.env.EKSHAMATA_PASSWORD, `EKSHAMATA_EMAIL (works on ${host})`);
  return out;
}

/** The single best account for one environment (what the pickers display). */
export function credentialsFor(baseUrl, opts = {}) {
  return credentialCandidates(baseUrl, opts)[0] ?? null;
}
