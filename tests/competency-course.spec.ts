import { test, expect } from '@playwright/test';
import { openCompetencyHome } from './helpers/session';
import { SelfAssessmentPage } from './pages/self-assessment.page';
import { CoursePlayer } from './pages/course-player.page';
import { fetchAnswerKey, quizIdFromUrl, type AnswerKey } from '../src/utils/answer-key';
import { fetchRealAnswerKey, fetchKeyByDoId, captureApiHeaders } from './helpers/real-answer-key';
import {
  recordArtifact, saveArtifacts, resetArtifacts, doIdFromUrl, collectionIdFromUrl, artifacts,
} from './helpers/artifact-log';
import { START_COURSE, START_LEVEL, GO_HOME, COMPETENCY_ACHIEVED } from './helpers/labels';

/**
 * Fail-then-course scenario (mirrors the mobile course-completion flow):
 *
 *   start competency → level → (if selected) FAIL the self-assessment →
 *   "Start Learning" the mapped course → complete every module (which clears the
 *   level) → next level. Levels NOT selected are passed directly. Finally, verify
 *   the Passbook lists the completed items.
 *
 * Select which levels to fail from the terminal (interactive: scripts/climb-competency.mjs):
 *   $env:FAIL_LEVELS="1,3"   → fail L1 and L3 via their courses; pass the rest.
 *   $env:FAIL_LEVELS="all"   → fail every level via its course.
 */
const ORG = (process.env.ORG || 'BNRC').toUpperCase();
const COMPETENCY = (process.env.COMPETENCY || 'Pregnancy Identification').trim();
const LEVELS = Number(process.env.LEVELS || 5);
const MAX_MODULES = Number(process.env.MAX_MODULES || 60);

const failLevels = new Set<number>();
{
  const raw = (process.env.FAIL_LEVELS || '').trim().toLowerCase();
  if (raw === 'all') for (let i = 1; i <= LEVELS; i++) failLevels.add(i);
  else raw.split(/[,\s]+/).filter(Boolean).forEach((n) => { if (/^\d+$/.test(n)) failLevels.add(Number(n)); });
}

test.describe(`Competency + Course — ${COMPETENCY} (fail: ${[...failLevels].join(',') || 'none'})`, () => {
  test.setTimeout(120 * 60 * 1000); // course completion (5 levels × courses + big assessments) runs long

  // The resolved on-screen competency title (set once the run starts).
  let resolvedTitle = COMPETENCY;

  // Save on the way out, so a run that fails mid-way still leaves the full
  // do_id + name trail for every level it touched.
  test.afterEach(async () => {
    await saveArtifacts(resolvedTitle);
  });

  test(`clears ${LEVELS} levels (failing ${[...failLevels].join(',') || 'none'} via courses)`, async ({ page }) => {
    resetArtifacts();
    captureApiHeaders(page);
    const home = await openCompetencyHome(page);
    const sa = new SelfAssessmentPage(page);
    const course = new CoursePlayer(page);

    const title = await test.step(`Start competency "${COMPETENCY}" (fail levels: ${[...failLevels].join(',') || 'none'})`,
      () => home.startSelfAssessmentByName(COMPETENCY));
    resolvedTitle = title || COMPETENCY;
    console.log(`[C+C] competency: ${title} | fail levels: ${[...failLevels].join(',') || 'none'}`);

    // The quiz id each level opened. A climb that does not really advance
    // re-serves the SAME assessment every time (only ?viewMode changes), and
    // without this the run answered level 1 five times over and still reported
    // the competency complete.
    const quizIdByLevel = new Map<number, string>();
    // How many times each level was re-handled because the portal didn't credit it.
    const redoCount = new Map<number, number>();

    for (let level = 1; level <= LEVELS; level++) {
      // Each level presents EITHER a self-assessment quiz OR — once we're on the
      // remediation track — the mapped course directly. Detect which and handle it.
      const screen = await detectScreen(page, 45_000);
      console.log(`[C+C] Level ${level}: screen = ${screen}`);
      let advanced = false;         // a course-completion sequence moved us onward
      let competencyDone = false;   // the WHOLE competency is complete (stop the loop)

      if (screen === 'quiz') {
        const quizUrl = page.url();
        const saName = await screenTitle(page, `${COMPETENCY} — Level ${level}`);
        const quizId = quizIdFromUrl(quizUrl);
        // NOTE: a repeated quiz id does NOT mean the climb stalled. Several
        // competencies serve all five levels from ONE questionset — "Vaginal
        // examination and plotting on partograph" lists five levels that all
        // point at do_1141156194039398401106, and its key holds 40 questions for
        // 5 levels of 5. Progress is proven by the QUESTIONS changing, so that
        // is what is recorded and checked.
        if (quizId) quizIdByLevel.set(level, quizId);
        // This level's own artifact first (deterministic), then the sniffed key.
        let key: AnswerKey | null = quizId ? await fetchKeyByDoId(page, quizId).catch(() => null) : null;
        if (!key) key = await fetchRealAnswerKey(page).catch(() => null);
        if (!key && quizId) key = await fetchAnswerKey(quizId).catch(() => null);
        expect(key, `Level ${level}: could not obtain an answer key`).toBeTruthy();

        if (failLevels.has(level)) {
          // ── FAIL the assessment deliberately, then complete the mapped course ──
          await test.step(`Level ${level}: ❌ fail self-assessment (deliberate)`, async () => {
            await sa.failWithKey(key!, 40, level);
            await expect.poll(() => sa.isResult(), { timeout: 25_000, message: `L${level}: no result` }).toBe(true);
            expect(await sa.passed(), `Level ${level} should have FAILED (deliberate)`).toBe(false);
          });
          console.log(`[C+C] Level ${level}: ❌ failed (deliberate)`);
          await recordArtifact({
            level, kind: 'self-assessment',
            doId: quizId || doIdFromUrl(quizUrl), name: saName,
            outcome: 'failed-deliberately', url: quizUrl,
          });
          competencyDone = await clearLevelViaCourse(page, course, level, LEVELS, home, COMPETENCY, MAX_MODULES);
          advanced = true;
        } else {
          // ── Try to PASS the assessment; if it doesn't clear (e.g. no key), fall
          //    back to the mapped course ("Take the course to achieve the level")
          //    instead of hard-failing. The step title is neutral until we know
          //    the outcome; a result step then states what actually happened. ──
          const { answered, passed, score } = await test.step(`Level ${level}: attempt self-assessment`, async () => {
            const a = await sa.completeWithKey(key!, 40, () => fetchRealAnswerKey(page), level);
            await expect.poll(() => sa.isResult(), { timeout: 25_000, message: `L${level}: no result` }).toBe(true);
            return { answered: a, passed: await sa.passed(), score: await sa.resultScore() };
          });
          await recordArtifact({
            level, kind: 'self-assessment',
            doId: quizId || doIdFromUrl(quizUrl), name: saName,
            outcome: `${passed ? 'passed' : 'not-cleared'}${score ? ` (${score})` : ''}`, url: quizUrl,
          });
          if (passed) {
            console.log(`[C+C] Level ${level}: ✅ passed (${answered} answered)`);
            await test.step(`Level ${level}: ✅ self-assessment passed (${answered} answered)`, async () => {});
          } else {
            expect(
              answered,
              `Level ${level}: the assessment rendered but NO question was answered — `
              + 'the quiz was not actually taken, so falling through to the course would '
              + 'report a level as cleared that was never attempted',
            ).toBeGreaterThan(0);
            console.log(`[C+C] Level ${level}: ⚠️ self-assessment not cleared (${answered} answered) → completing via course`);
            await test.step(`Level ${level}: ⚠️ self-assessment NOT cleared (${answered} answered) → complete via course`, async () => {});
            competencyDone = await clearLevelViaCourse(page, course, level, LEVELS, home, COMPETENCY, MAX_MODULES);
            advanced = true;
          }
        }
      } else if (screen === 'course') {
        // ── Level presented directly as a mapped course (remediation chain) ──
        const directUrl = page.url();
        await recordArtifact({
          level,
          kind: 'course',
          doId: collectionIdFromUrl(directUrl) || doIdFromUrl(directUrl),
          name: await courseTitle(page, `Level ${level} mapped course`),
          outcome: 'opened (direct)',
          url: directUrl,
        });
        const modules = await test.step(`Level ${level}: complete mapped course`,
          () => course.completeCourse(MAX_MODULES, `L${level} course`));
        expect(modules, `Level ${level}: course had no modules`).toBeGreaterThanOrEqual(1);
        console.log(`[C+C] Level ${level}: 🎉 cleared via course (${modules} modules, direct)`);
        await recordArtifact({
          level,
          kind: 'course',
          doId: collectionIdFromUrl(page.url()) || collectionIdFromUrl(directUrl) || doIdFromUrl(directUrl),
          name: await courseTitle(page, `Level ${level} mapped course`),
          outcome: `completed (${modules} modules, direct)`,
          url: page.url(),
        });

        competencyDone = await test.step(`Level ${level}: 🎉 cleared via course (${modules} modules) → advance`,
          () => advanceAfterCourse(page, level, LEVELS, home, COMPETENCY, directUrl));
        advanced = true;
      } else {
        throw new Error(`Level ${level}: could not detect a quiz or course screen (url: ${page.url()})`);
      }

      // ── Did the PORTAL credit this level? The counter above is ours; the
      //    passbook is the portal's. They drifted on UAT: the level-1 course
      //    "completed" after 1 of its 5 modules, the counter moved to 2, the next
      //    "level" was the rest of the SAME course — and from there every level
      //    was one off: "Level 5" was really level 4 and the real level-5 course
      //    was never opened, yet the run reported the competency complete.
      //    So: if the passbook doesn't list this level, it was not a level —
      //    re-open the competency (it opens whatever level the portal says is
      //    next) and handle the SAME level number again.
      const credited = await creditedLevels(page);
      if (credited && !credited.has(level)) {
        const tries = (redoCount.get(level) ?? 0) + 1;
        redoCount.set(level, tries);
        console.log(`[C+C] ⚠️  the portal has NOT credited Level ${level} (passbook: ${[...credited].sort((a, b) => a - b).join(',') || 'none'})`
          + ` — not a level yet; re-opening and handling Level ${level} again (${tries}/3)`);
        expect(tries, `Level ${level} was handled ${tries} times but the portal never credited it`).toBeLessThan(3);
        if ((await reopenCompetency(page, home, COMPETENCY)) === 'completed') break;
        level--;
        continue;
      }
      if (credited) console.log(`[C+C] ✔ portal credited Level ${level} (passbook: ${[...credited].sort((a, b) => a - b).join(',')})`);

      // A single course can be mapped to EVERY level — finishing it achieves the
      // whole competency ("Competency Achieved"), so stop instead of chasing more.
      if (competencyDone) {
        console.log(`[C+C] 🏆 competency achieved at Level ${level} — no further levels to clear`);
        break;
      }

      // ── Advance to the next level (course completions already advanced via
      //    advanceAfterCourse; this handles the SA-pass case) ──
      if (!advanced && level < LEVELS) {
        await test.step(`Level ${level}: → advance to Level ${level + 1}`,
          () => goToNextLevel(page, sa, home, COMPETENCY, level));
        // the SA-pass transition can also land on "Competency Achieved".
        if (await isCompetencyAchieved(page)) {
          console.log(`[C+C] 🏆 "Competency Achieved" after Level ${level} — complete`);
          await clickVisibleButton(page, GO_HOME).catch(() => {});
          break;
        }
      }
    }

    console.log(`[C+C] ✅ ${title} — competency completed`);

    // ── After the whole competency is completed, verify it shows in the Passbook.
    //    The Passbook lists the completed competency with color-coded level chips:
    //    Self (green) = self-assessment, Training (yellow) = course. ──
    await test.step('Verify the completed competency shows in the Passbook', async () => {
      await verifyPassbook(page, title, LEVELS);
    });

    // ── The portal must have SAVED every level's course. The Passbook check above
    //    only proves the competency is listed; a run whose courses were never
    //    enrolled still passes it (seen on UAT: every course back at "Start",
    //    My Courses Started (0) / Completed (0), the competency back at level 1).
    //    So open each course this run completed and read what the portal shows. ──
    await test.step('Verify every level course is saved as completed on the portal', async () => {
      await verifyCoursesSaved(page);
    });
  });
});

/**
 * The levels the PORTAL has credited for the competency being climbed, read from
 * its own passbook (POST /apis/proxies/v8/user/v1/passbook — the call the
 * Passbook tab makes; the page's session cookie authorises it, no navigation).
 * The competency is the one with the most recent credit (the one this run is
 * working on). Returns null when the passbook can't be read, so a read failure
 * never blocks a run; an empty set means nothing is credited yet.
 */
async function creditedLevels(page: any): Promise<Set<number> | null> {
  const res = await page.evaluate(async () => {
    try {
      const r = await fetch('/apis/proxies/v8/user/v1/passbook', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: { typeName: 'competency' } }),
      });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }).catch(() => null);
  if (!res) return null;
  const comps = Object.values<any>(res?.result?.content?.[0]?.competencies || {});
  if (!comps.length) return new Set();
  const newest = (c: any) => Math.max(0, ...(c.acquiredDetails || []).map((d: any) => Date.parse(d.createdDate || d.acquiredDate || '') || 0));
  const current = comps.sort((a, b) => newest(b) - newest(a))[0];
  return new Set((current.acquiredDetails || [])
    .map((d: any) => Number(d.competencyLevelId ?? d.additionalParams?.competencyLevelId))
    .filter((n: number) => Number.isFinite(n)));
}

/**
 * For every course this run reports as completed, open its overview page and
 * read the banner button: a course the portal has saved as finished offers
 * "Start Again" / "फिर से शुरू करें" (or shows 100%). "Start" means it never
 * recorded the user at all; "Resume" means it is unfinished. Fails listing them.
 */
async function verifyCoursesSaved(page: any): Promise<void> {
  const BASE = (process.env.BASE_URL ?? 'https://ekshamata.aastrika.org').replace(/\/+$/, '');
  const ids = [...new Set(artifacts()
    .filter((a) => a.kind === 'course' && /^completed/.test(a.outcome) && /^do_/.test(a.doId || ''))
    .map((a) => `${a.level}|${a.doId}`))];
  const seen = new Set<string>();
  const notSaved: string[] = [];
  for (const key of ids) {
    const [level, doId] = key.split('|');
    if (seen.has(doId)) continue; // one course can serve several levels
    seen.add(doId);
    await page.goto(`${BASE}/app/toc/${doId}/overview?primaryCategory=Course`).catch(() => {});
    const banner = page.locator('.banner-btn:visible, #start-btn:visible').first();
    await banner.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
    const label = (await banner.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    const done = /again|फिर\s*से/i.test(label) || /\b100\s*%/.test(body);
    console.log(`[C+C] L${level} course ${doId}: "${label || '(no button)'}" → ${done ? '✅ saved as completed' : '❌ NOT saved as completed'}`);
    if (!done) notSaved.push(`L${level} ${doId} ("${label || 'no button'}")`);
  }
  expect(notSaved, `the portal did not save these courses as completed: ${notSaved.join(', ')}`).toEqual([]);
}

/**
 * Open the Competency dashboard → Passbook tab (via the header Competency nav —
 * a direct URL redirects home) and verify the completed competency is listed
 * with its level chips. Expands the ▼ dropdown for the self-assessment / course
 * detail (best-effort screenshot). Asserts on the reliable, language-independent
 * signals: the Self/Training legend, the "Levels:" row, and a competency panel.
 */
async function verifyPassbook(page: any, competency: string, levels: number): Promise<void> {
  const BASE = process.env.BASE_URL ?? 'https://ekshamata.aastrika.org';

  const onDashboard = () => page.getByRole('tab', { name: /passbook|पासबुक/i })
    .or(page.getByText(/competency dashboard|योग्यता डैशबोर्ड/i)).first()
    .isVisible({ timeout: 2_500 }).catch(() => false);
  for (let i = 0; i < 3 && !(await onDashboard()); i++) {
    const nav = page.getByRole('button', { name: /^(competency|योग्यता)$/i }).or(page.getByText(/^(competency|योग्यता)$/i)).first();
    if (await nav.isVisible({ timeout: 2_500 }).catch(() => false)) {
      await nav.click().catch(() => {});
    } else {
      await page.goto(`${BASE}/page/home`).catch(() => {});
      await page.waitForTimeout(1_500);
      await page.getByRole('button', { name: /^(competency|योग्यता)$/i }).or(page.getByText(/^(competency|योग्यता)$/i)).first().click().catch(() => {});
    }
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2_500);
  }

  // Passbook tab — English "Passbook" OR Hindi "पासबुक"
  await page.locator([
    '[role="tab"]:has-text("Passbook")', 'mat-tab-label:has-text("Passbook")',
    '.mat-mdc-tab:has-text("Passbook")', 'button:has-text("Passbook")', 'a:has-text("Passbook")',
    '[role="tab"]:has-text("पासबुक")', 'mat-tab-label:has-text("पासबुक")',
    '.mat-mdc-tab:has-text("पासबुक")', 'button:has-text("पासबुक")', 'a:has-text("पासबुक")',
  ].join(', ')).first().click({ timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(1_500);
  await page.waitForTimeout(2_500);
  await page.screenshot({ path: 'test-results/passbook-final.png', fullPage: true }).catch(() => {});

  const info = await page.evaluate((comp: string) => {
    const body = document.body.innerText || '';
    // legend labels — English "Self/Training" OR Hindi ("स्व"/"प्रशिक्षण") if present
    const hasLegend = (/\bSelf\b/i.test(body) && /\bTraining\b/i.test(body)) || (/स्व/.test(body) && /प्रशिक्षण/.test(body));
    return {
      panels: document.querySelectorAll('.mat-expansion-panel, mat-expansion-panel').length,
      hasLegend,
      hasLevels: /Levels\s*:|स्तर\s*:|लेवल/i.test(body),
      nameMatch: body.toLowerCase().includes((comp || '').toLowerCase().slice(0, 10)),
      snippet: body.replace(/\s+/g, ' ').slice(0, 220),
    };
  }, competency).catch(() => null);
  console.log(`[C+C] passbook: ${JSON.stringify(info)}`);

  await page.screenshot({ path: 'test-results/passbook-final-expanded.png', fullPage: true }).catch(() => {});

  // Genuine check: the completed competency must appear as a row in the PASSBOOK
  // tab (panels) with its name. This correctly FAILS when the competency is not
  // listed in the Passbook — which is a real finding, not a language issue (the
  // detection above is Hindi-tolerant and `nameMatch` uses the on-screen title).
  const completedOnHome = await isCompetencyInCompletedSection(page, competency);
  console.log(`[C+C] passbook: panels=${info?.panels} nameMatch=${info?.nameMatch} homeCompleted=${completedOnHome}`);

  expect(info, 'could not read Passbook state').toBeTruthy();
  expect(info!.panels, 'competency not listed in the Passbook tab (no competency row)').toBeGreaterThanOrEqual(1);
  expect(info!.nameMatch, 'competency name not found in the Passbook').toBe(true);
  // The name being listed proves little (a competency stuck at level 4 is listed
  // too). The portal's passbook must credit EVERY level 1..levels.
  const credited = await creditedLevels(page);
  if (credited) {
    const missing = Array.from({ length: levels }, (_, i) => i + 1).filter((n) => !credited.has(n));
    console.log(`[C+C] passbook credits levels: ${[...credited].sort((a, b) => a - b).join(',') || 'none'}`);
    expect(missing, `the portal has NOT credited level(s) ${missing.join(', ')} of this competency`).toEqual([]);
  }
  console.log(`[C+C] ✅ Passbook shows the completed competency (${levels} levels)`);
}

/**
 * Detect what the current level is presenting: a self-assessment `quiz`
 * (`/viewer/quiz/`) or a mapped `course` (the `/app/toc/` overview with a
 * Start button + Modules tab, or an already-open `/viewer/*` course resource).
 * Polls until one is recognised or the timeout elapses.
 */
async function detectScreen(page: any, timeoutMs: number): Promise<'quiz' | 'course' | 'unknown'> {
  // timeoutMs = 0 still makes ONE attempt (used as a fast probe inside the
  // post-course loop).
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const url = page.url();
    if (/\/viewer\/quiz\//i.test(url)) return 'quiz';
    if (/\/app\/toc\//i.test(url)) return 'course';
    if (/\/viewer\/(pdf|video|html|content)\//i.test(url)) return 'course';

    // The competency HOME and dashboard are neither. They must be excluded
    // BEFORE the DOM heuristic below, because a home card's "Start Self
    // Assessment" button satisfies its start-button test (START_COURSE matches a
    // bare "Start"). That is how a run came to treat /page/home as the course
    // player and count 62 seconds of sitting on the home page as "module 1
    // completed" — a level that was never cleared reported "cleared via course".
    const onHome = /\/page\/home|\/page\/competency|\/app\/competency/i.test(url);

    if (!onHome) {
      const isCourseOverview = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a')).map((b) => (b.textContent || '').trim());
        // Fragment match, both languages — an anchored English-only test called
        // a Hindi "कोर्स शुरू करें" screen 'no start button'.
        const hasStart = btns.some((t) => START_COURSE.test(t));
        const hasModulesTab = Array.from(document.querySelectorAll('*')).some(
          (e) => e.children.length === 0 && /^Modules$/i.test((e.textContent || '').trim()));
        return hasStart && hasModulesTab;
      }).catch(() => false);
      if (isCourseOverview) return 'course';
    }

    // The deadline used to be computed and never read, so this loop could not
    // end: 'unknown' was unreachable and a run that landed somewhere unexpected
    // span here until the whole test timed out, with no clue why.
    if (Date.now() >= deadline) {
      console.log(`[C+C] detectScreen: gave up after ${timeoutMs}ms at ${url}`);
      return 'unknown';
    }
    await page.waitForTimeout(1_500);
  }
}


/**
 * Click the first VISIBLE button matching `name`. The app stacks many overlays
 * (dialogs:55) that contain HIDDEN duplicate buttons, so `.first()` often targets
 * an invisible copy and the click silently fails — we enumerate and click the
 * one that is actually visible. Returns true if a visible button was clicked.
 */
async function clickVisibleButton(page: any, name: RegExp): Promise<boolean> {
  const btns = page.getByRole('button', { name });
  const n = await btns.count().catch(() => 0);
  for (let k = 0; k < n; k++) {
    const b = btns.nth(k);
    if (await b.isVisible().catch(() => false)) {
      await b.scrollIntoViewIfNeeded().catch(() => {});
      await b.click().catch(() => b.click({ force: true }).catch(() => {}));
      return true;
    }
  }
  // Fallback: the role/name match is flaky for non-Latin (Hindi) labels — click the
  // smallest VISIBLE element whose textContent matches (language-agnostic).
  return page.evaluate((src: string) => {
    const re = new RegExp(src, 'i');
    const vis = (e: Element) => (e as HTMLElement).offsetParent !== null;
    const cand = Array.from(document.querySelectorAll('button, a, [role="button"], .btn'))
      .filter((e) => vis(e) && re.test((e.textContent || '').trim()))
      .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
    if (!cand) return false;
    ((cand.closest('button, a, [role="button"]') as HTMLElement) || (cand as HTMLElement)).click();
    return true;
  }, name.source).catch(() => false);
}

/**
 * Give a 5-star rating and Submit, if a rating widget is on screen. The stars
 * are `<img name="Star">`, but stacked overlays contain HIDDEN duplicates, and a
 * CSS `:visible` filter proved unreliable — so we enumerate the star locators and
 * pick the actually-visible ones via isVisible(). Returns 'submitted', 'waiting'
 * (stars present but not submittable yet), or 'absent' (no rating).
 */
async function submitRating(page: any): Promise<'submitted' | 'waiting' | 'absent'> {
  // Stars: <img name="Star"> (role) OR any star-classed element (Hindi UI may not
  // expose an English accessible name).
  let stars = page.getByRole('img', { name: /star/i });
  let n = await stars.count().catch(() => 0);
  if (n < 5) {
    const cls = page.locator('img[alt*="star" i], [class*="star" i]');
    if ((await cls.count().catch(() => 0)) >= 5) { stars = cls; n = await cls.count().catch(() => 0); }
  }
  const visible: number[] = [];
  for (let k = 0; k < n; k++) {
    if (await stars.nth(k).isVisible().catch(() => false)) visible.push(k);
  }
  console.log(`[C+C] rating: ${visible.length}/${n} stars visible`);
  if (visible.length < 5) return 'absent';
  const idx = visible[Math.min(4, visible.length - 1)]; // the 5th VISIBLE star
  await stars.nth(idx).click({ timeout: 3_000 }).catch(() => stars.nth(idx).click({ force: true }).catch(() => {}));
  await page.waitForTimeout(800);
  // Submit: English "Submit" OR Hindi "सबमिट" / "जमा करें".
  const submit = page.getByRole('button', { name: /^(submit|submit review|submit rating|सबमिट|जमा करें)$/i }).first();
  let enabled = (await submit.isVisible({ timeout: 1_500 }).catch(() => false)) && (await submit.isEnabled().catch(() => false));
  console.log(`[C+C] rating: submit enabled = ${enabled}`);
  if (enabled) { await submit.click().catch(() => {}); return 'submitted'; }
  // Fallback: click a visible button whose text is Submit/सबमिट (role match can miss Hindi).
  const clicked = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((e) =>
      /^(submit|सबमिट|जमा करें)$/i.test((e.textContent || '').trim()) && (e as HTMLElement).offsetParent !== null && !(e as HTMLButtonElement).disabled);
    if (!b) return false; (b as HTMLElement).click(); return true;
  }).catch(() => false);
  return clicked ? 'submitted' : 'waiting';
}

/**
 * Clear a level by completing its mapped course: open it via the fail-result
 * "Start Learning" (visible instance; re-open from home if that doesn't land on
 * the course), walk every module, then run the post-course advance. Used for
 * deliberately-failed levels AND for pass-levels whose self-assessment didn't
 * clear (the app's "Take the course to achieve the level" path).
 */
async function clearLevelViaCourse(page: any, course: CoursePlayer, level: number, totalLevels: number, home: any, competency: string, maxModules: number): Promise<boolean> {
  await test.step(`Level ${level}: start mapped course`, async () => {
    const clicked = await clickVisibleButton(page, /start\s+(learning|course)|सीखना\s*(शुरू|आरंभ)|कोर्स\s*(शुरू|आरंभ)|पाठ्यक्रम\s*शुरू/i);
    console.log(`[C+C] Level ${level}: clicked visible "Start Learning" = ${clicked}`);
    // Clicking "Start Learning" navigates from the quiz to the course TOC, but
    // the SPA takes about a second. detectScreen() called straight away still
    // sees the QUIZ and reports failure — which sent us home to re-enter the
    // course, losing the in-competency launch context that makes the app show
    // the "Level N passed → Start level N+1 course" popup at the end. Wait for
    // the navigation before classifying.
    const urlBeforeStart = page.url();
    await page.waitForURL((u: URL) => u.toString() !== urlBeforeStart, { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(1_500);
    let sc = await detectScreen(page, 30_000);
    if (sc !== 'course') {
      console.log(`[C+C] Level ${level}: "Start Learning" did not open the course (screen=${sc}) → re-open from home`);
      await reopenCompetency(page, home, competency);
      sc = await detectScreen(page, 45_000);
    }
    console.log(`[C+C] Level ${level}: mapped course screen = ${sc}  ${page.url()}`);
  });

  // Which COURSE cleared this level — the player carries the course id as
  // ?collectionId=do_…, with the module's own do_id in the path.
  const courseUrl = page.url();
  await recordArtifact({
    level,
    kind: 'course',
    doId: collectionIdFromUrl(courseUrl) || doIdFromUrl(courseUrl),
    name: await courseTitle(page, `Level ${level} mapped course`),
    outcome: 'opened',
    url: courseUrl,
  });

  const modules = await test.step(`Level ${level}: complete mapped course`,
    () => course.completeCourse(maxModules, `L${level} course`));
  expect(modules, `Level ${level}: course had no modules`).toBeGreaterThanOrEqual(1);
  console.log(`[C+C] Level ${level}: 🎉 cleared via course (${modules} modules)`);
  await recordArtifact({
    level,
    kind: 'course',
    doId: collectionIdFromUrl(page.url()) || collectionIdFromUrl(courseUrl) || doIdFromUrl(courseUrl),
    name: await courseTitle(page, `Level ${level} mapped course`),
    outcome: `completed (${modules} modules)`,
    url: page.url(),
  });

  // returns true if this course completed the WHOLE competency (one course → all levels)
  return test.step(`Level ${level}: 🎉 cleared via course (${modules} modules) → advance`,
    () => advanceAfterCourse(page, level, totalLevels, home, competency, courseUrl));
}

/**
 * Post-course sequence (matches the recorded manual flow):
 *   assessment "Result: Pass → Continue"  →  "Submit your feedback" (5★ → Submit)
 *   →  (ideally) "Congratulations! Level N passed → Start level N+1 course".
 *
 * NOTE: in automation the app usually returns to home after the feedback (the
 * "Level N passed" popup only fires on the manual in-competency launch), so the
 * "Start level N+1" click is BEST-EFFORT and the reliable path to the next level
 * is the competency re-open (which opens the next level's course directly).
 */
async function advanceAfterCourse(page: any, level: number, totalLevels: number, home: any, competency: string, tocUrl?: string): Promise<boolean> {
  // The level popup renders on the COURSE TOC page (/app/toc/<course>/overview),
  // which is where the manual journey ends up once the player closes. Finishing
  // the last module leaves us inside /viewer/…, and dismissing the feedback
  // dialog from there exits the player straight to /page/home — so go back to
  // the TOC first and let the popup appear where it actually lives.
  if (tocUrl && /\/viewer\//.test(page.url())) {
    // Leave the player the way a person does — the back chevron — so the SPA
    // keeps its completion state. A page.goto() to the same URL reloads the app
    // and the popup never fires (verified: TOC renders empty, no popup).
    const backed = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, mat-icon, a')).find((e) => {
        const t = (e.textContent || '').trim().toLowerCase();
        return (t === 'chevron_left' || t === 'arrow_back') && (e as HTMLElement).offsetParent !== null;
      }) as HTMLElement | undefined;
      if (!btn) return false;
      btn.click();
      return true;
    }).catch(() => false);
    console.log(`[C+C] ← leaving the player via ${backed ? 'the back chevron' : 'history.back()'} so the level popup can show`);
    if (!backed) await page.goBack().catch(() => {});
    await page.waitForTimeout(2_500);
  }
  // 1) assessment result → "Continue" (brief)
  for (let i = 0; i < 4; i++) {
    if (await clickVisibleButton(page, /^(continue|जारी रखें|जारी रखे|आगे बढ़ें)$/i)) { await page.waitForTimeout(1_200); break; }
    await page.waitForTimeout(800);
  }

  // 2) After the course finishes the app runs a fast chain:
  //      assessment result → "Continue" → feedback (5★ + Submit)
  //      → "Congratulations! Level N passed" popup → and then it routes HOME.
  //
  //    Measured in automation: the popup is on screen at t+0 and gone by t+1s,
  //    so every screen is handled from ONE fast loop that checks for the popup
  //    first and re-checks within ~250ms of each action. Handling the screens
  //    one-at-a-time at 1s granularity always arrived after the redirect.
  //    (The rating dialog does not always appear, so the popup check must NOT
  //     be nested inside the rating branch.)
  let startedNextLevel = false;
  let ratingSubmitted = false;
  const postCourse = Date.now() + 25_000;
  while (Date.now() < postCourse) {
    if (process.env.POPUP_DEBUG) {
      const st = await page.evaluate(() => ({
        url: location.pathname,
        backdrop: document.querySelectorAll('.cdk-overlay-backdrop').length,
        dialogs: document.querySelectorAll('mat-dialog-container, [role="dialog"]').length,
        congrats: /बधाई|congratulation/i.test(document.body.innerText || ''),
        levelText: /(लेवल|level)\s*\d+\s*(पास|passed)/i.test(document.body.innerText || ''),
        btns: Array.from(document.querySelectorAll('button'))
          .filter((b) => (b as HTMLElement).offsetParent !== null && (b.textContent || '').trim())
          .map((b) => (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 26)).slice(0, 10),
      })).catch(() => null);
      console.log(`[loop-dbg] ${JSON.stringify(st)}`);
    }
    // (a) the prize — check first, and again immediately after every action
    if (level < totalLevels && (await clickStartNextLevelFast(page, level, 0))) {
      startedNextLevel = true;
      break;
    }
    // (b) the whole competency finished in one go
    if (await isCompetencyAchieved(page)) break;
    // (c) The assessment RESULT sits under the feedback dialog and must be
    //     cleared FIRST — that is the order the manual journey uses:
    //     submit assessment → जारी रखें → close feedback → level popup.
    if (await clickVisibleButton(page, /^(continue|जारी रखें|जारी रखे|आगे बढ़ें)$/i)) {
      if (process.env.POPUP_DEBUG) console.log('[loop-dbg] clicked Continue');
      await page.waitForTimeout(400);
      continue;
    }
    // (d) the feedback dialog — CLOSE it (X) rather than submitting: submitting
    //     redirects to /page/home and the level popup never renders. Verify it
    //     really closed; a reported click that leaves the dialog up means we hit
    //     the wrong element.
    if (!ratingSubmitted && (await closeRatingDialog(page))) {
      await page.waitForTimeout(500);
      const stillOpen = await page.evaluate(() =>
        Array.from(document.querySelectorAll('mat-dialog-container, [role="dialog"]'))
          .some((d) => (d as HTMLElement).offsetParent !== null
            && !!d.querySelector('img[alt*="star" i], [class*="star" i]'))).catch(() => false);
      if (!stillOpen) {
        ratingSubmitted = true;
        console.log('[C+C] closed the feedback dialog with X (keeps the app on the course page)');
        continue; // straight back to (a) — the popup follows within a beat
      }
      if (process.env.POPUP_DEBUG) console.log('[loop-dbg] X click did not close the feedback dialog');
    }
    // (e) already routed home → nothing left to catch
    if (/\/page\/home/.test(page.url())) break;
    await page.waitForTimeout(250);
  }

  // 3) Did we catch the popup and open the next level directly?
  if (startedNextLevel) {
    const sc = await detectScreen(page, 30_000);
    console.log(`[C+C] → Level ${level + 1} opened straight from the popup → screen=${sc}  ${page.url()}`);
    if (sc === 'course' || sc === 'quiz') return false;
    console.log('[C+C] ⚠️  popup click did not land on the next level — falling back');
  }

  if (process.env.POPUP_DEBUG) await snapshotAfterRating(page, 15);
  const popup = await waitForLevelPopup(page, startedNextLevel ? 3_000 : 8_000);

  // 3a) WHOLE-COMPETENCY completion: one course can be mapped to every level, so
  //     finishing it clears the entire competency at once.
  if (popup === 'competency-achieved' || (await isCompetencyAchieved(page))) {
    console.log('[C+C] 🏆 "Competency Achieved" popup — the whole competency is complete');
    await page.screenshot({ path: 'test-results/competency-achieved.png' }).catch(() => {});
    await clickVisibleButton(page, GO_HOME).catch(() => {});
    return true;
  }

  if (level >= totalLevels) return true; // reached the configured last level

  // 3b) "Start level N+1 course" — the happy path.
  if (popup === 'level-passed') {
    console.log(`[C+C] 🎉 "Level ${level} passed" popup shown`);
    const started = await clickVisibleButton(
      page,
      /start\s+level\s*\d*\s*course|start(?:\s+next)?\s+level|next\s+level|लेवल\s*\d+\s*(का\s*)?(कोर्स|पाठ्यक्रम)?\s*शुरू|अगला\s*लेवल/i,
    );
    if (started) {
      // Confirm the next level's course actually opened (screen, not just URL —
      // the player keeps the same route shape between levels).
      const sc = await detectScreen(page, 30_000);
      console.log(`[C+C] → clicked "Start level ${level + 1} course" → screen=${sc}  ${page.url()}`);
      if (sc === 'course' || sc === 'quiz') return false;
      console.log('[C+C] ⚠️  the popup click did not open the next level — falling back to home');
    } else {
      console.log('[C+C] ⚠️  no "Start level" button on the popup — using "Go back to home"');
    }
    // Either button leads somewhere usable: home → re-open the competency.
    await clickVisibleButton(page, GO_HOME).catch(() => {});
    await page.waitForTimeout(2_000);
  }

  // 4) fallback: re-open the competency → opens the next level's course. If it
  //    has moved to the home "COMPLETED" section, the whole competency is done.
  console.log(`[C+C] → advancing to Level ${level + 1} via competency re-open`);
  const status = await reopenCompetency(page, home, competency);
  if (status === 'completed') {
    console.log('[C+C] 🏆 competency is in the home COMPLETED section — complete');
    return true;
  }
  return false;
}

/**
 * Wait for the post-course popup and say which one it is.
 *   'level-passed'         → "Congratulations! Level N passed — NN% Achieved"
 *   'competency-achieved'  → the whole competency is done
 *   'none'                 → nothing appeared within the timeout
 */
async function waitForLevelPopup(page: any, timeoutMs: number): Promise<'level-passed' | 'competency-achieved' | 'none'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = ((await page.locator('body').innerText().catch(() => '')) || '');
    if (COMPETENCY_ACHIEVED.test(body)) return 'competency-achieved';
    // English: "Level 1 passed" / Hindi: "लेवल 1 पास" — plus the Start/Go-home pair.
    if (/level\s*\d+\s*passed|लेवल\s*\d+\s*(पास|उत्तीर्ण)/i.test(body)
        && (START_LEVEL.test(body) || GO_HOME.test(body))) return 'level-passed';
    await page.waitForTimeout(1_000);
  }
  console.log('[C+C] ⚠️  no level-completion popup appeared within ' + Math.round(timeoutMs / 1000) + 's');
  return 'none';
}

/** True if the "Congratulations! Competency Achieved" popup is on screen. */
async function isCompetencyAchieved(page: any): Promise<boolean> {
  const body = ((await page.locator('body').innerText().catch(() => '')) || '');
  return COMPETENCY_ACHIEVED.test(body);
}

/** True if `competency` now sits in the home "COMPLETED(N)" section (it has left
 *  the active learning plan → the whole competency is finished). */
async function isCompetencyInCompletedSection(page: any, competency: string): Promise<boolean> {
  return page.evaluate((comp: string) => {
    const norm = (s: string) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const body = norm(document.body.innerText || '');
    const m = body.match(/completed\s*\(\d+\)/);
    if (!m) return false;
    const idx = body.indexOf(m[0]);
    return body.slice(idx, idx + 500).includes(norm(comp).slice(0, 18));
  }, competency).catch(() => false);
}

/**
 * Move to the next level. GOAL: from the result/congratulations popup, click
 * "Start Level N+1 course" to land on that level's course TOC page.
 *
 * The rating was already submitted in waitForCongrats — we must NOT dismiss a
 * rating again here: the congratulations popup carries its OWN star widget, and
 * submitting it closes the popup (taking the "Start Level N" button with it).
 * So we PRIORITISE the button, wait up to 20s for it, and only re-open from home
 * as a LAST RESORT if no popup appears.
 */
async function goToNextLevel(page: any, sa: SelfAssessmentPage, home: any, competency: string, level: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  let dumped = false;
  while (Date.now() < deadline) {
    // 1) PREFER the VISIBLE "Start Level N+1 course" button — check it FIRST every
    //    pass, so a combined rating+button popup gets its button clicked (never
    //    dismissed). Target the visible instance (hidden duplicates exist).
    if (await clickVisibleButton(page, /start(?:\s+next)?\s+level|next\s+level|लेवल\s*\d+\s*शुरू|अगला\s*लेवल/i)) {
      console.log(`[C+C] → Start Level ${level + 1} (popup button)`);
      await page.waitForURL(/\/app\/toc\/|\/viewer\//i, { timeout: 15_000 }).catch(() => {});
      if (/\/app\/toc\/|\/viewer\//i.test(page.url())) {
        console.log(`[C+C] → reached ${/\/app\/toc\//.test(page.url()) ? 'course TOC' : 'player'}: ${page.url()}`);
        return;
      }
    }

    if (!dumped) { dumped = true; await dumpPopupState(page, level); }

    // 2) button not up yet — if a rating popup is BLOCKING, clear it so the
    //    next-level popup behind it can surface.
    const result = await submitRating(page);
    if (result === 'submitted') {
      console.log('[C+C] cleared a blocking rating → re-checking for next-level popup');
      await page.waitForTimeout(4_000);
      await dumpPopupState(page, level, 'after-rating-submit'); // does "Level N passed" appear now?
      continue;
    }
    await page.waitForTimeout(1_500);
  }
  console.log(`[C+C] no "Start Level ${level + 1}" popup within 20s → fallback: re-open from home (last resort)`);
  await reopenCompetency(page, home, competency);
}

/** Diagnostic: dump what's actually on screen when the next-level popup is
 *  expected — visible buttons, star widgets, dialogs — to see why it's absent. */
async function dumpPopupState(page: any, level: number, tag = 'next-level'): Promise<void> {
  const info = await page.evaluate(() => {
    const vis = (e: Element) => (e as HTMLElement).offsetParent !== null;
    const btns = Array.from(document.querySelectorAll('button')).filter(vis)
      .map((b) => (b.textContent || '').trim()).filter(Boolean).slice(0, 30);
    const stars = Array.from(document.querySelectorAll('img')).filter((i) =>
      /star/i.test((i.getAttribute('alt') || '') + (i.getAttribute('aria-label') || ''))).length;
    const dialogs = document.querySelectorAll('[role="dialog"], .modal, .mat-dialog-container, .cdk-overlay-container *').length;
    const body = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 220);
    return { url: location.href, stars, dialogs, btns, body };
  }).catch(() => null);
  console.log(`[C+C] 🔎 L${level} ${tag} state: ${JSON.stringify(info)}`);
  const path = `test-results/popup-L${level}-${tag}.png`;
  await page.screenshot({ path, fullPage: false }).catch(() => {});
  console.log(`[C+C] 📸 screenshot: ${path}`);
}

/**
 * Re-open the competency from home to reach the next incomplete level / its
 * mapped course. If the competency has moved to the home "COMPLETED" section (a
 * single course cleared every level), it is no longer startable — report
 * 'completed'; otherwise open it and report 'opened'.
 */
async function reopenCompetency(page: any, home: any, competency: string): Promise<'opened' | 'completed'> {
  const BASE = process.env.BASE_URL ?? 'https://ekshamata.aastrika.org';
  await page.goto(`${BASE}/page/home`).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await home.waitForLoaded().catch(() => {});

  if (await isCompetencyInCompletedSection(page, competency)) return 'completed';
  try {
    await home.startSelfAssessmentByName(competency);
    await page.waitForTimeout(3_000);
    return 'opened';
  } catch {
    // Not in the active learning plan → it has been completed.
    return 'completed';
  }
}

/** Best-effort on-screen title of the current screen (quiz / assessment). */
async function screenTitle(page: any, fallback: string): Promise<string> {
  const raw = (await page.locator('h1, h2, .assessment-title, [class*="title"]').first()
    .innerText({ timeout: 3_000 }).catch(() => '')) || '';
  const name = raw.replace(/\s+/g, ' ').trim();
  return name && name.length <= 120 ? name : fallback;
}

/**
 * The mapped course's name. The player shows it in the header/TOC; fall back to
 * a level label so the reports always pair a name with the do_id.
 */
async function courseTitle(page: any, fallback: string): Promise<string> {
  for (const sel of ['.course-name', '.content-title', 'h1', 'h2', '[class*="course-title"]']) {
    const raw = (await page.locator(sel).first().innerText({ timeout: 1_500 }).catch(() => '')) || '';
    const name = raw.replace(/\s+/g, ' ').trim();
    if (name && name.length <= 120) return name;
  }
  return fallback;
}

/** POPUP_DEBUG: log what is on screen each second after the feedback submit. */
async function snapshotAfterRating(page: any, seconds: number): Promise<void> {
  for (let i = 0; i < seconds; i++) {
    const snap = await page.evaluate(() => ({
      url: location.pathname + location.search.slice(0, 60),
      dialogs: document.querySelectorAll('mat-dialog-container, .modal, [role="dialog"]').length,
      buttons: Array.from(document.querySelectorAll('button, a'))
        .filter((b) => (b as HTMLElement).offsetParent !== null && (b.textContent || '').trim())
        .map((b) => (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 28))
        .slice(0, 8),
      congrats: /congratulation|बधाई/i.test(document.body.innerText || ''),
    })).catch(() => null);
    console.log(`[popup-dbg] t+${i}s ${JSON.stringify(snap)}`);
    await page.waitForTimeout(1_000);
  }
}

/**
 * Click "Start level N+1 course" the INSTANT the level-completion popup renders.
 *
 * Manually the popup sits there waiting; in automation the app routes back to
 * /page/home in well under a second (measured: present at t+0, gone by t+1s).
 * A 1s poll always arrived too late, so this spins fast and clicks immediately.
 */
async function clickStartNextLevelFast(page: any, level: number, timeoutMs = 8_000): Promise<boolean> {
  // timeoutMs = 0 still makes ONE attempt (used as a fast probe inside the
  // post-course loop, which does its own looping).
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const clicked = await page.evaluate(() => {
      const re = /start\s+level\s*\d*\s*(course)?|लेवल\s*\d+\s*(का\s*)?(कोर्स|पाठ्यक्रम)?\s*शुरू/i;
      const btn = Array.from(document.querySelectorAll("button, a")).find((b) => {
        const t = (b.textContent || "").replace(/\s+/g, " ").trim();
        return re.test(t) && (b as HTMLElement).offsetParent !== null;
      }) as HTMLElement | undefined;
      if (!btn) return "";
      btn.click();
      return (btn.textContent || "").replace(/\s+/g, " ").trim();
    }).catch(() => "");
    if (clicked) {
      console.log(`[C+C] ⚡ caught the level popup → clicked "${clicked}"`);
      return true;
    }
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(150);
  }
}
/**
 * Close the course-feedback dialog with its X icon instead of submitting it.
 *
 * Submitting the rating makes the app route straight back to /page/home, which
 * kills the "Level N passed → Start level N+1 course" popup before it renders
 * (measured: popup present at t+0, home by t+1s). Closing with the X leaves the
 * app on the course page, and the popup then appears and stays — the same as
 * doing it by hand. The rating itself is optional for the journey under test.
 */
async function closeRatingDialog(page: any): Promise<boolean> {
  return page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll(
      'mat-dialog-container, [role="dialog"], .modal, .mat-mdc-dialog-container'));
    for (const d of dialogs) {
      if ((d as HTMLElement).offsetParent === null) continue;
      // Only the FEEDBACK dialog — it holds the stars / a Submit control.
      const isFeedback = d.querySelector('img[alt*="star" i], [class*="star" i]')
        || Array.from(d.querySelectorAll("button")).some((b) =>
          /^(submit|सबमिट|जमा करें)$/i.test((b.textContent || "").trim()));
      if (!isFeedback) continue;
      const closer = Array.from(d.querySelectorAll('button, mat-icon, .close, [aria-label]')).find((e) => {
        const txt = (e.textContent || "").trim().toLowerCase();
        const label = (e.getAttribute("aria-label") || "").toLowerCase();
        return txt === "close" || txt === "✕" || txt === "×" || /close|बंद/.test(label);
      }) as HTMLElement | undefined;
      if (closer) { closer.click(); return true; }
    }
    return false;
  }).catch(() => false);
}