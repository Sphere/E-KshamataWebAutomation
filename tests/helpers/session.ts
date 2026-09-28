import { Page } from '@playwright/test';
import { getUserFor } from './user-lookup';
import { getOrg } from '../../src/config/orgs';
import { loginWithPassword, BASE_URL } from './login';
import { ensureLanguage } from './language';
import { CompetencyHomePage } from '../pages/competency-home.page';

/**
 * Land on an authenticated Competency home and return its page object.
 *
 * Auth is auto-detected:
 *   - the localhost dev server is already authenticated → use that session.
 *   - a live portal shows the login screen → provision a fresh user for the org
 *     in $env:ORG (default BNRC — must be a competency-homepage org) and log in.
 */
export async function openCompetencyHome(page: Page): Promise<CompetencyHomePage> {
  const home = new CompetencyHomePage(page);
  await page.goto(`${BASE_URL}/page/home`);
  await page.waitForLoadState('networkidle').catch(() => {});

  const alreadyAuthed = await page
    .locator('.asha-card')
    .first()
    .isVisible({ timeout: 8_000 })
    .catch(() => false);

  if (!alreadyAuthed) {
    const orgKey = (process.env.ORG || 'BNRC').toUpperCase();
    // If a specific role/designation was chosen (multi-role org), provision that
    // variant; otherwise the org's first designation.
    const wanted = (process.env.CREATE_DESIGNATION || '').trim();
    const variant = wanted ? getOrg(orgKey).designations.find((d) => d.designation === wanted) : undefined;
    // getUserFor — not createOrgUser — so REUSE_USERS=1 works here too. Every
    // competency run used to provision a brand-new account, and a just-created
    // account has no learning plan yet, so the home came up with no cards at all.
    const designation = variant?.designation ?? getOrg(orgKey).designations[0].designation;
    const user = await getUserFor(orgKey, designation);
    await loginWithPassword(page, user.email, user.password);
    // Log in and you land wherever the portal sends you — the Sphere app host,
    // a landing page, or whatever follows the Terms gate. NOT necessarily the
    // competency home. Waiting for .asha-card straight after login therefore
    // watched a page that would never grow one, and the run died with "no
    // competency cards" while the account's plan was perfectly healthy. Ask for
    // the competency home explicitly.
    await page.goto(`${BASE_URL}/page/home`);
    await page.waitForLoadState('networkidle').catch(() => {});
    await home.waitForLoaded();
  }

  // Some competencies present their self-assessment ONLY in Hindi (English serves
  // a video). ENSURE_LANG pins the portal language BOTH ways: 'hi' switches to
  // Hindi, 'en' switches back to English. Being explicit about English matters —
  // the language is a persisted account setting, so a previous Hindi run would
  // otherwise leak into every later run. Unset = leave whatever is there.
  const wantLang = (process.env.ENSURE_LANG || '').toLowerCase();
  if (wantLang === 'hi' || wantLang === 'en') {
    await ensureLanguage(page, wantLang);
    await home.waitForLoaded().catch(() => {});
  }
  return home;
}
