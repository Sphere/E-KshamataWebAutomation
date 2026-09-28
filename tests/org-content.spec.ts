import { test, expect } from '@playwright/test';
import { loginWithPassword, BASE_URL } from './helpers/login';
import { MyCoursesPage } from './pages/my-courses.page';
import { EXPECTED } from './fixtures/org-content-expected';
import { getUserFor } from './helpers/user-lookup';
import {
  recordObservation, checkMinimum, saveObservations, withNetworkRetry,
} from './helpers/org-observed';

/**
 * Org content validation — per org + designation, log in and assert the right
 * homepage TYPE and mapped-course COUNT show up:
 *   - 'competency' → the home shows the Competency Learning Plan (app-asha-learning).
 *   - 'courses'    → My Courses ▸ "For You (N)" matches the expected count.
 *
 * Expected values live in tests/fixtures/org-content-expected.ts (edit there).
 * Reuses the users in created-users.txt by default; set PROVISION=1 to mint
 * fresh users. Run: npm run test:org-content
 */
test.describe('Org content — homepage type & mapped courses (For You)', () => {
  // NOTE: do NOT use mode:'serial' here — in serial mode the FIRST failure skips
  // every remaining test. These checks are independent (fresh context + login
  // each), and playwright.config runs them one-at-a-time (workers:1), so a
  // failing org must not stop the others from running & reporting.

  // One snapshot of what every org actually showed, written at the end.
  test.afterAll(() => { saveObservations(); });

  for (const [orgKey, roles] of Object.entries(EXPECTED)) {
    for (const [designation, exp] of Object.entries(roles)) {
      const detail = exp.type === 'programs'
        ? (exp.programs != null ? ` (${exp.programs} programs)` : '')
        : (exp.forYou != null ? ` (For You ${exp.forYou})` : '');
      const label = `${orgKey} / ${designation} — ${exp.type}${detail}${exp.review ? ' [review]' : ''}`;

      test(label, async ({ page }) => {
        test.setTimeout(120_000);

        /**
         * Read "For You (N)". A null means the tab had not rendered yet — DMHUP
         * and PVTBIHAR both reported `Received: null` on a slow load, which reads
         * as a content failure when it is really a timing one. Re-open once.
         */
        /** Attach a labelled full-page capture — visual evidence of what this
         *  org actually renders, shown inline in the HTML/PDF run report. */
        const shot = async (what: string) => {
          await test.info().attach(`${orgKey}-${designation}-${what}`, {
            body: await page.screenshot({ fullPage: true }),
            contentType: 'image/png',
          }).catch(() => {});
        };

        const readForYou = async (mc: MyCoursesPage): Promise<number | null> => {
          let n = await mc.forYouCount();
          if (n == null) {
            console.log(`[VALIDATE] ${orgKey}/${designation}: "For You" not rendered yet — re-opening My Courses`);
            await page.waitForTimeout(3_000);
            await mc.open();
            await page.waitForTimeout(2_000);
            n = await mc.forYouCount();
          }
          return n;
        };
        // A FRESH user per org+designation (see helpers/user-lookup) so the
        // counts reflect today's mapping, not an old account's history.
        const user = await getUserFor(orgKey, designation);
        console.log(`[VALIDATE] ${orgKey}/${designation} as ${user.email}`);
        await withNetworkRetry(`${orgKey}/${designation} login`,
          () => loginWithPassword(page, user.email, user.password));

        const goHome = () => withNetworkRetry(`${orgKey}/${designation} home`, async () => {
          await page.goto(`${BASE_URL}/page/home`);
          await page.waitForLoadState('networkidle').catch(() => {});
          await page.waitForTimeout(3_000);
          await shot('home');
        });

        // ── Program-card homepage (home "PROGRAMS" section) ────────────
        if (exp.type === 'programs') {
          await goHome();
          const mc = new MyCoursesPage(page);
          const cards = await mc.programCardCount();
          const names = await page.locator('.program-card, [class*="program"] h3, [class*="program"] h4')
            .allInnerTexts().catch(() => []);
          const res = checkMinimum(cards, exp.review ? null : exp.programs, `${orgKey}/${designation}: program cards`);
          console.log(`[VALIDATE] ${res.message}`);
          recordObservation({
            org: orgKey, designation, email: user.email, type: 'programs',
            observed: { programCards: cards }, expected: { programs: exp.programs ?? null },
            drift: res.drift, titles: names.map((n) => n.replace(/s+/g, ' ').trim()).filter(Boolean).slice(0, 10),
          });
          expect(cards, `${orgKey}/${designation}: PROGRAMS should render`).toBeGreaterThan(0);
          expect(res.ok, res.message).toBe(true);
          return;
        }

        // ── Competency homepage: Learning Plan on home (+ optional For You) ──
        if (exp.type === 'competency') {
          await goHome();
          const plan = page.locator('app-asha-learning');
          await plan.first().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
          const cards = await plan.count();
          const titles = await page.locator('.asha-m-title').allInnerTexts().catch(() => []);
          console.log(`[VALIDATE] ${orgKey}/${designation}: competency cards=${cards} :: ${JSON.stringify(titles.slice(0, 20))}`);
          expect(cards, `${orgKey}/${designation}: expected a Competency Learning Plan on home`).toBeGreaterThan(0);

          let forYou: number | null = null;
          let res = { ok: true, drift: '', message: '' };
          if (exp.forYou != null || exp.review) {
            const mc = new MyCoursesPage(page);
            await mc.open();
            await shot('my-courses');
            forYou = await readForYou(mc);
            // More competencies on the home ⇒ more mapped courses in For You, so
            // the fixture number is a floor, not an equality.
            res = checkMinimum(forYou, exp.review ? null : exp.forYou, `${orgKey}/${designation}: For You`);
            console.log(`[VALIDATE] ${res.message}`);
          }
          recordObservation({
            org: orgKey, designation, email: user.email, type: 'competency',
            observed: { competencyCards: cards, forYou },
            expected: { forYou: exp.forYou ?? null },
            drift: res.drift, titles: titles.map((t) => t.replace(/s+/g, ' ').trim()).slice(0, 10),
          });
          expect(res.ok, res.message).toBe(true);
          return;
        }

        // ── courses / none: assert the "For You" count ─────────────────
        const mc = new MyCoursesPage(page);
        await mc.open();
        await shot('my-courses');
        const forYou = await readForYou(mc);
        const started = await mc.startedCount();
        const completed = await mc.completedCount();
        console.log(
          `[VALIDATE] ${orgKey}/${designation}: For You=${forYou} ` +
          `(expected ${exp.type === 'none' ? 0 : (exp.forYou ?? 'any>0')}), Started=${started}, Completed=${completed}`,
        );

        expect(forYou, `${orgKey}/${designation}: "For You" tab should render a count`).not.toBeNull();

        if (exp.type === 'none') {
          expect(forYou, `${orgKey}/${designation}: expected NO mapped courses`).toBe(0);
        } else if (exp.review) {
          // Unconfirmed — the log shows the real number; just confirm it loads.
          expect(forYou!, `${orgKey}/${designation}: For You should be non-empty`).toBeGreaterThan(0);
        } else if (exp.forYou != null) {
          const res = checkMinimum(forYou, exp.forYou, `${orgKey}/${designation}: For You`);
          console.log(`[VALIDATE] ${res.message}`);
          expect(res.ok, res.message).toBe(true);
        } else {
          expect(forYou!, `${orgKey}/${designation}: For You should be non-empty`).toBeGreaterThan(0);
        }

        recordObservation({
          org: orgKey, designation, email: user.email, type: exp.type,
          observed: { forYou, started, completed },
          expected: { forYou: exp.type === 'none' ? 0 : (exp.forYou ?? null) },
          drift: '',
        });

        if (exp.names?.length) {
          const titles = (await mc.forYouCourseTitles()).map((t) => t.toLowerCase());
          for (const name of exp.names) {
            expect(
              titles.some((t) => t.includes(name.toLowerCase())),
              `${orgKey}/${designation}: expected course "${name}" in For You`,
            ).toBe(true);
          }
        }
      });
    }
  }
});
