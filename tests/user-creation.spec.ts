import { test, expect } from '@playwright/test';
import { getOrg, loadProfile } from '../src/config/orgs';
import { getOrgChannel, createUser, assignRole, updateProfile } from '../src/api/Ekshamata-api';
import { loginWithPassword } from './helpers/login';

/**
 * User creation process — every step of provisioning a new org user is its own
 * reportable `test.step` (resolve channel → create user → assign role → update
 * profile → log in). Shows up in the branded report as sub-rows under the test.
 *
 *   Pick the org:  $env:CREATE_ORG="BNRC"; npm run run:create-user-test
 *   Default org:   BNRC
 *
 * Needs the provisioning creds in .env (SPHERE_API_TOKEN + SPHERE_API_COOKIE).
 */
const ORG = (process.env.CREATE_ORG || 'BNRC').toUpperCase();
const PASSWORD = process.env.EKSHAMATA_USER_PASSWORD || 'Aastrika@123';

test.describe(`User creation — ${ORG}`, () => {
  test(`provision and log in a ${ORG} user (step by step)`, async ({ page }) => {
    test.setTimeout(120_000);

    const org = getOrg(ORG);
    // Pick the designation/role: CREATE_DESIGNATION (exact match, set by the
    // interactive launcher for multi-role orgs) else the org's first variant.
    const wanted = (process.env.CREATE_DESIGNATION || '').trim();
    const variant = org.designations.find((d) => d.designation === wanted) || org.designations[0];
    console.log(`[create-user] org=${ORG} role="${variant.designation}"`);
    const email = `${variant.emailPrefix}${Date.now().toString().slice(-6)}@yopmail.com`;
    let channel = '';
    let userId = '';

    await test.step(`Resolve org channel (${org.name})`, async () => {
      channel = await getOrgChannel(org.orgId);
      expect(channel, 'org channel resolved from the org API').toBeTruthy();
    });

    await test.step(`Create user ${email}  (POST /api/user/v3/create)`, async () => {
      // organisationId is REQUIRED on staging — its /api/user/v3/create rejects
      // every channel value. Passing both lets the client try organisationId
      // first there and fall back to channel on production.
      userId = await createUser({
        email, firstName: 'Aastrika', lastName: 'User', password: PASSWORD,
        channel, organisationId: org.orgId,
      });
      expect(userId, 'new userId returned').toBeTruthy();
      console.log(`[create-user] ${email} → ${userId}`);
    });

    await test.step(`Assign PUBLIC role in org ${org.orgId}`, async () => {
      await assignRole(userId, org.orgId, ['PUBLIC']);
    });

    await test.step(`Update profile (designation = ${variant.designation})`, async () => {
      const profile = loadProfile(org);
      const prof = profile?.profileReq?.professionalDetails?.[0];
      if (prof) prof.designation = variant.designation;
      await updateProfile(userId, profile);
    });

    await test.step('Log in with the new user (UI, password)', async () => {
      await loginWithPassword(page, email, PASSWORD);
      expect(page.url(), 'left the login screen').not.toContain('/public/login');
    });
  });
});
