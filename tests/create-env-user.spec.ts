/**
 * Provision ONE user on the environment BASE_URL points at, then prove it can
 * actually sign in there.
 * ──────────────────────────────────────────────────────────────────────────
 * Production and staging are separate backends: an account made on one cannot
 * log in to the other. So each environment gets its own account, and the
 * staging one is stamped so it is obvious which is which —
 *
 *   production   BNRC-ANM007@yopmail.com          Aastrika User
 *   staging      STAGE-BNRC-ANM001@yopmail.com    Stage User
 *
 * Both are appended to created-users.txt with `env=<host>`.
 *
 *   npm run create:pair -- BNRC         one on EACH environment (both at once)
 *   $env:CREATE_ORG="BNRC"; npm run create:user:prod
 *   $env:CREATE_ORG="BNRC"; npm run create:user:stage
 *
 * The login check runs in a FRESH incognito context — its own cookie jar and
 * storage — so a session left behind by an earlier run cannot make a broken
 * account look like a working one.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getOrg } from '../src/config/orgs';
import { createOrgUser, envTag } from '../src/utils/user-factory';
import { loginWithPassword, BASE_URL } from './helpers/login';

const ORG = (process.env.CREATE_ORG || 'BNRC').toUpperCase();
const WANTED = (process.env.CREATE_DESIGNATION || '').trim();

test.describe(`Create a user on ${new URL(BASE_URL).hostname}`, () => {
  test(`provisions a ${ORG} user and signs it in`, async ({ browser }) => {
    test.setTimeout(180_000);

    const org = getOrg(ORG);
    const variant = org.designations.find((d) => d.designation === WANTED) ?? org.designations[0];
    const tag = envTag();
    console.log(`[create] ${new URL(BASE_URL).hostname} · ${ORG} · "${variant.designation}"${tag ? ` · tagged ${tag}` : ''}`);

    const user = await test.step(`Provision on ${new URL(BASE_URL).hostname}`, async () => {
      const created = await createOrgUser(ORG, variant);
      expect(created.userId, 'the API returned a userId').toBeTruthy();
      return created;
    });

    // A brand-new context = a fresh incognito window: no cookies, no storage,
    // nothing carried over from any earlier run on this machine.
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await test.step(`Sign in as ${user.email} (fresh incognito)`, async () => {
        await loginWithPassword(page, user.email, user.password);
        expect(page.url(), 'left the login screen').not.toContain('/public/login');
      });

      // Hand the working session on, so whatever runs next (the comparison)
      // does not have to log this brand-new account in a SECOND time. Same file
      // shape scripts/lib/env-login.mjs reads.
      await test.step('Save the session for the next step', async () => {
        const file = resolve(
          __dirname, '..', '.cache',
          `state-${new URL(BASE_URL).hostname}-${user.email.replace(/[^a-z0-9]/gi, '_')}.json`,
        );
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ savedAt: new Date().toISOString(), state: await context.storageState() }, null, 2));
      });
    } finally {
      await context.close();
    }

    console.log(`[create] ✅ ${user.email} / ${user.password}  (${user.designation})  on ${user.env}`);
  });
});
