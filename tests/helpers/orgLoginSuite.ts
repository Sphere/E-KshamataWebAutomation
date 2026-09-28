import { test, expect } from '@playwright/test';
import { createOrgUser } from '../../src/utils/user-factory';
import { getOrg } from '../../src/config/orgs';
import { getUserFor } from './user-lookup';
import { loginWithPassword } from './login';

/**
 * Shared web suite for one org — the Playwright twin of the mobile
 * `orgLoginSuite` (D:\Mobile automation\src\utils\org-login-suite.ts).
 *
 * Creates + logs in ONE user PER designation variant of the org (so orgs with
 * multiple roles — e.g. SHSB [ANM-Bihar, CHO-Bihar], MP [ANM-MP, CHO-MP] —
 * get a user for EACH role, all recorded to created-users.txt).
 *
 * Two modes (chosen per run via env):
 *   - default             provision a BRAND-NEW user per role via the Sphere APIs.
 *   - USE_EXISTING_USER=1  reuse the most recent account for that org+role from
 *                          created-users.txt (or pin one with USER_EMAIL).
 *
 * Each per-org spec (tests/orgs/<KEY>.spec.ts) is just `orgLoginSuite('<KEY>')`.
 */
export function orgLoginSuite(orgKey: string): void {
  const org = getOrg(orgKey);
  const useExisting = process.env.USE_EXISTING_USER === '1';

  test.describe(`Ekshamata web — ${org.name} (${orgKey})`, () => {
    // One test per designation variant → one user created (or reused) per role.
    for (const variant of org.designations) {
      test(`${variant.designation} — logs in, accepts T&C, verifies login`, async ({ page }) => {
        const user = useExisting
          ? await getUserFor(orgKey, variant.designation) // reuse (or provision if none)
          : await createOrgUser(orgKey, variant);          // always a fresh user for this role
        console.log(`[${orgKey}] ${variant.designation}: ${user.email}`);

        await loginWithPassword(page, user.email, user.password);
        const url = page.url();
        console.log(`[${orgKey}] ${variant.designation} post-login URL:`, url);
        expect(url).not.toContain('/public/login');
        expect(url).not.toMatch(/new-tnc|\/consent/);
        // NOTE: this correctly ends on sphere.aastrika.org — the Ekshamata web
        // build hardcodes sphere.aastrika.org as its instance, so the
        // authenticated app lives on the Sphere host. That is expected.
      });
    }
  });
}
