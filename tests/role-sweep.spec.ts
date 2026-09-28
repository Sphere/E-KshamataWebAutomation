/**
 * Role verification sweep — every org x designation in src/config/orgs.ts.
 *
 * For each role: provision a fresh user, log in, capture the homepage, record
 * which homepage kind that role gets, and list the whole "For You" catalogue.
 * The sweep then writes its own Excel + HTML report alongside the standard run
 * reports.
 *
 *   npm run roles                       every role (~1 min each)
 *   npm run roles -- -g "MP|NHMMP"      just the matching ones
 *   REUSE_USERS=1 npm run roles         reuse existing accounts instead of minting
 *
 * Each role is an independent test (fresh context + login), and the config runs
 * them one at a time, so a role that fails does not stop the rest.
 */
import { test, expect } from '@playwright/test';
import { ORGS } from '../src/config/orgs';
import { loginWithPassword, BASE_URL } from './helpers/login';
import { MyCoursesPage } from './pages/my-courses.page';
import { getUserFor } from './helpers/user-lookup';
import { withNetworkRetry, checkMinimum } from './helpers/org-observed';
import { EXPECTED } from './fixtures/org-content-expected';
import { recordRole, writeRoleReports, type RoleRow } from './helpers/role-report';
import { getOrgChannel } from '../src/api/Ekshamata-api';

test.describe('Role verification sweep', () => {
  test.afterAll(async () => {
    const written = await writeRoleReports();
    if (written.length) {
      console.log('\n📋 Role sweep report:');
      written.forEach((f) => console.log('   ' + f));
    }
  });

  for (const [orgKey, org] of Object.entries(ORGS)) {
    for (const variant of org.designations) {
      const designation = variant.designation;

      test(`${orgKey} / ${designation}`, async ({ page }) => {
        test.setTimeout(360_000);

        const row: RoleRow = {
          org: orgKey,
          orgName: org.name,
          orgId: org.orgId,
          orgChannel: '',
          designation,
          email: '',
          homepage: 'error',
          competencies: null,
          programs: null,
          forYou: null,
          started: null,
          completed: null,
          catalogue: [],
          homeItems: [],
          note: '',
        };

        // What this org id resolves to ON THIS ENVIRONMENT. The ids are the
        // same on production and staging today, but that is a fact worth
        // re-checking every sweep rather than assuming — and the channel it
        // returns is the org's real name on that backend. Best-effort: a sweep
        // reusing existing accounts may have no API token at all, and that
        // must not fail the role.
        row.orgChannel = await getOrgChannel(org.orgId).catch(() => '');
        console.log(`[ROLE] ${orgKey} "${org.name}" [${org.orgId}]${row.orgChannel ? ` → channel "${row.orgChannel}"` : ' (id not resolved on this environment)'}`);

        try {
          // ── provision + log in ──────────────────────────────────
          const user = await getUserFor(orgKey, designation);
          row.email = user.email;
          console.log(`[ROLE] ${orgKey}/${designation} as ${user.email}`);
          await withNetworkRetry(`${orgKey}/${designation} login`,
            () => loginWithPassword(page, user.email, user.password));

          // ── homepage ────────────────────────────────────────────
          await withNetworkRetry(`${orgKey}/${designation} home`, async () => {
            await page.goto(`${BASE_URL}/page/home`);
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForTimeout(3_000);
          });

          // Capture it — viewport, not full page: this image is embedded in the
          // sweep's HTML for every role, and full-page shots of a long homepage
          // make that file enormous.
          const shot = await page.screenshot().catch(() => null);
          if (shot) {
            row.screenshot = shot.toString('base64');
            await test.info().attach(`${orgKey}-${designation}-home`, {
              body: shot, contentType: 'image/png',
            }).catch(() => {});
          }

          // Which homepage did this role get?
          // Both card kinds render lazily, so COUNTING IMMEDIATELY IS A RACE:
          // NHMMP was once misreported as "courses" because neither kind had
          // painted yet. Wait for whichever appears first, then count.
          const mc = new MyCoursesPage(page);
          await Promise.race([
            page.locator('app-asha-learning').first().waitFor({ state: 'visible', timeout: 15_000 }),
            page.locator('[class*="program-card"]').first().waitFor({ state: 'visible', timeout: 15_000 }),
          ]).catch(() => { /* neither: a For-You / empty homepage */ });
          const competencyCards = await page.locator('app-asha-learning').count().catch(() => 0);
          const programCards = await mc.programCardCount().catch(() => 0);

          if (competencyCards > 0) {
            row.homepage = 'competency';
            row.competencies = competencyCards;
            row.homeItems = (await page.locator('.asha-m-title').allInnerTexts().catch(() => []))
              .map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
          } else if (programCards > 0) {
            row.homepage = 'programs';
            row.programs = programCards;
            row.homeItems = (await page.locator('[class*="program-card"]').allInnerTexts().catch(() => []))
              .map((t) => t.replace(/\s+/g, ' ').trim().slice(0, 90)).filter(Boolean);
          } else {
            row.homepage = 'courses';
          }

          // ── the For-You catalogue ───────────────────────────────
          await mc.open();
          row.forYou = await mc.forYouCount();
          if (row.forYou == null) {
            // A null means the tab had not rendered yet, which is not the same
            // as "this role has no courses" — re-open once before believing it.
            await page.waitForTimeout(3_000);
            await mc.open();
            row.forYou = await mc.forYouCount();
          }
          row.started = await mc.startedCount();
          row.completed = await mc.completedCount();
          row.catalogue = await mc.forYouCourseTitles().catch(() => []);
          // A null count means the tab never rendered — the catalogue is the
          // better evidence, so only call it 'none' when BOTH say empty.
          if (row.homepage === 'courses' && (row.forYou ?? 0) === 0 && row.catalogue.length === 0) {
            row.homepage = 'none';
          }

          console.log(
            `[ROLE] ${orgKey}/${designation}: homepage=${row.homepage}`
            + ` competencies=${row.competencies ?? '-'} programs=${row.programs ?? '-'}`
            + ` ForYou=${row.forYou ?? '-'} catalogue=${row.catalogue.length}`,
          );
        } catch (e: any) {
          row.note = String(e?.message ?? e).split('\n')[0].slice(0, 200);
          console.log(`[ROLE] ${orgKey}/${designation}: ✖ ${row.note}`);
          throw e;
        } finally {
          // Record whatever we learned, including on failure — a role that dies
          // half way is still evidence, and the report should show it.
          recordRole(row);
        }

        // ── assertions ──────────────────────────────────────────
        // Checked against the SAME fixture org-content.spec.ts uses, so the two
        // specs cannot disagree about what a role should see. Counts are
        // MINIMUMS: content grows, and a run should fail only when it shrinks.
        const expected = EXPECTED[orgKey]?.[designation];

        expect(row.homepage, `${orgKey}/${designation}: no homepage rendered`).not.toBe('error');

        if (!expected) {
          // No fixture entry: assert only what is true of every role, and say so
          // rather than passing silently on an unknown.
          console.log(`[ROLE] ${orgKey}/${designation}: no fixture entry — asserted loosely`);
          expect(row.email, `${orgKey}/${designation}: no account was provisioned`).toBeTruthy();
          return;
        }

        expect(
          row.homepage,
          `${orgKey}/${designation}: expected a "${expected.type}" homepage, got "${row.homepage}"`,
        ).toBe(expected.type);

        if (expected.type === 'competency') {
          expect(
            row.competencies ?? 0,
            `${orgKey}/${designation}: competency homepage rendered no learning-plan cards`,
          ).toBeGreaterThan(0);
        }

        if (expected.type === 'programs') {
          const res = checkMinimum(row.programs, expected.programs, `${orgKey}/${designation}: PROGRAMS cards`);
          expect(res.ok, res.message).toBe(true);
        }

        if (expected.type === 'none') {
          expect(row.forYou ?? 0, `${orgKey}/${designation}: expected NO mapped courses`).toBe(0);
        } else if (expected.forYou != null) {
          const res = checkMinimum(row.forYou, expected.forYou, `${orgKey}/${designation}: For You`);
          // `review: true` marks a value not yet confirmed against the sheet —
          // assert only that something rendered, and log the real number so the
          // fixture can be locked in from live data.
          if (expected.review) {
            console.log(`[ROLE] ${orgKey}/${designation}: For You = ${row.forYou ?? '-'} (fixture under review)`);
            expect(row.forYou, `${orgKey}/${designation}: "For You" tab never rendered`).not.toBeNull();
          } else {
            expect(res.ok, res.message).toBe(true);
          }
        }

        // Named courses, when the fixture pins them, must actually be listed.
        for (const name of expected.names ?? []) {
          expect(
            row.catalogue.some((c) => c.toLowerCase().includes(name.toLowerCase())),
            `${orgKey}/${designation}: "${name}" missing from For You (${row.catalogue.length} course(s) listed)`,
          ).toBe(true);
        }
      });
    }
  }
});
