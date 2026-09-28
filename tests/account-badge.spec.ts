/**
 * Account ▸ My Certificates — the badge a learner earns for finishing the
 * courses mapped to their org.
 * ─────────────────────────────────────────────────────────────────────────
 * Verifies the "N Badges Earned" pill under the learner's name. The interesting
 * failure is the quiet one: a learner who has finished the org's courses and
 * still has no pill — which looks fine from the course side (every module
 * complete) and is only visible here. Note the pill is NOT the same as
 * Account ▸ My Certificates: an account can show 9 badges and no certificates.
 *
 *   $env:ORG="MP"; npm run test:badge              a user of that org
 *   $env:ACCOUNT_EMAIL="MP-ANM111@yopmail.com"; $env:ACCOUNT_PASSWORD="…"; npm run test:badge
 *
 * Inputs:
 *   ACCOUNT_EMAIL / ACCOUNT_PASSWORD   the learner to check
 *                 → else EKSHAMATA_EMAIL / EKSHAMATA_PASSWORD from .env
 *                 → else a user for $env:ORG (default MP)
 *   EXPECT_BADGE=0   report what is there without failing when none is earned
 */
import { test, expect } from '@playwright/test';
import { loginWithPassword, BASE_URL } from './helpers/login';
import { readAccountBadges } from './helpers/account-badges';
import { getUserFor } from './helpers/user-lookup';

const ORG = (process.env.ORG || 'MP').toUpperCase();
const EXPECT_BADGE = process.env.EXPECT_BADGE !== '0';

async function account(): Promise<{ email: string; password: string; source: string }> {
  if (process.env.ACCOUNT_EMAIL && process.env.ACCOUNT_PASSWORD) {
    return { email: process.env.ACCOUNT_EMAIL, password: process.env.ACCOUNT_PASSWORD, source: 'ACCOUNT_EMAIL' };
  }
  if (process.env.EKSHAMATA_EMAIL && process.env.EKSHAMATA_PASSWORD) {
    return { email: process.env.EKSHAMATA_EMAIL, password: process.env.EKSHAMATA_PASSWORD, source: 'EKSHAMATA_EMAIL' };
  }
  const user = await getUserFor(ORG, (process.env.CREATE_DESIGNATION || '').trim());
  return { email: user.email, password: user.password, source: `${ORG} user` };
}

test.describe(`Account ▸ My Certificates — ${ORG}`, () => {
  test.setTimeout(180_000);

  test('the badge earned for completing the org courses is listed', async ({ page }) => {
    const env = new URL(BASE_URL).hostname;
    const who = await account();

    await test.step(`Log in as ${who.email} (${who.source})`,
      () => loginWithPassword(page, who.email, who.password));

    const state = await test.step('Read the badge pill on the Account page', () => readAccountBadges(page));

    console.log(state.count !== null
      ? `[badge] ${who.email} on ${env}: "${state.label}"`
      : `[badge] ${who.email} on ${env}: NO badge pill on the Account page or the home page`
        + `${state.noCertificates ? ' (My Certificates is also empty)' : ''}`);

    // EXPECT_BADGE=0 turns this into a report rather than a gate — useful for
    // checking an account that is only part-way through its courses.
    if (!EXPECT_BADGE) return;

    expect(
      state.count,
      `${who.email} (${ORG}) shows no "Badges Earned" pill on ${env} —`
        + ' it should appear under the name on the Account page once the org courses are done.'
        + ' The same account showing a pill on production and none on staging is an environment bug, not a test one.',
    ).not.toBeNull();
    expect(state.count ?? 0, `${who.email} (${ORG}) shows "${state.label}" on ${env}`).toBeGreaterThan(0);
  });
});
