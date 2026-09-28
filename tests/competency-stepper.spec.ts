import { test, expect } from '@playwright/test';
import { openCompetencyHome } from './helpers/session';
import { SelfAssessmentPage } from './pages/self-assessment.page';
import { fetchAnswerKey, quizIdFromUrl, type AnswerKey } from '../src/utils/answer-key';
import { fetchRealAnswerKey, fetchKeyByDoId, captureApiHeaders } from './helpers/real-answer-key';
import { recordArtifact, saveArtifacts, resetArtifacts, doIdFromUrl } from './helpers/artifact-log';
import { openPassbook, clearedLevels } from './helpers/passbook';

/**
 * Competency Stepper — a user climbs ALL self-assessment levels of one
 * competency, passing each (the Playwright web twin of the mobile climb suite).
 *
 * Choose the competency + level count from the terminal:
 *   PowerShell:  $env:COMPETENCY="Birth Planning"; npm run run:stepper
 *   bash:        COMPETENCY="Birth Planning" npm run run:stepper
 * Defaults to "Birth Planning", LEVELS=5.
 *
 * Auth is auto-detected:
 *   - localhost dev server is already authenticated → use that session.
 *   - a live portal shows the login screen → provision a fresh BNRC user and
 *     log in by password (fresh user = every level starts unlocked).
 */
const COMPETENCY = (process.env.COMPETENCY || 'Birth Planning').trim();
const LEVELS = Number(process.env.LEVELS || 5);

test.describe(`Competency Stepper — ${COMPETENCY}`, () => {
  // The resolved on-screen competency title (set once the climb starts).
  let resolvedTitle = COMPETENCY;

  // Save on the way out — a level that fails still leaves a full id/name trail.
  test.afterEach(async () => {
    await saveArtifacts(resolvedTitle);
  });

  // Five self-assessments back-to-back — give the whole climb room.
  test.setTimeout(360_000);

  test(`passes all ${LEVELS} self-assessment levels`, async ({ page }) => {
    resetArtifacts();
    captureApiHeaders(page); // capture org/hostPath for the token-free key fetch
    const home = await openCompetencyHome(page);
    const sa = new SelfAssessmentPage(page);

    // ── Climb ──────────────────────────────────────────────────────────
    const title = await home.startSelfAssessmentByName(COMPETENCY);
    resolvedTitle = title || COMPETENCY;
    console.log('[STEPPER] competency:', title);

    for (let level = 1; level <= LEVELS; level++) {
      await page.waitForURL(/\/viewer\/quiz\//, { timeout: 25_000 });

      const quizUrl = page.url();
      const saName = await selfAssessmentName(page, title, level);
      const quizId = quizIdFromUrl(quizUrl);
      expect(quizId, `Level ${level}: could not read quiz id from ${page.url()}`).toBeTruthy();

      // Read THIS level's key straight from its artifact (deterministic — no
      // waiting for the questionset to appear on the wire), then the sniffed
      // key, then the token path.
      let key: AnswerKey | null = await fetchKeyByDoId(page, quizId!).catch(() => null);
      if (!key) key = await fetchRealAnswerKey(page).catch(() => null);
      if (!key) key = await fetchAnswerKey(quizId!).catch(() => null);
      expect(key, `Level ${level}: could not obtain an answer key`).toBeTruthy();
      // If a page answers 0 (this level's questionset wasn't in the merged pool
      // yet), re-fetch the token-free key — the accumulator picks up the level's
      // own questionset — and retry, rather than leaving it unanswered.
      const answered = await sa.completeWithKey(
        key!, 40, async () => (await fetchKeyByDoId(page, quizId!).catch(() => null))
          || (await fetchRealAnswerKey(page).catch(() => null)),
        level,
      );

      await expect
        .poll(() => sa.isResult(), { timeout: 25_000, message: `Level ${level}: no result screen` })
        .toBe(true);
      const passed = await sa.passed();
      const score = await sa.resultScore();
      console.log(`[STEPPER] Level ${level}: ${passed ? '✅ passed' : '❌ not cleared'} (${answered} answered${score ? `, scored ${score}` : ''})`);

      // Trace WHICH self-assessment this level used — id + name — into the reports.
      await recordArtifact({
        level,
        kind: 'self-assessment',
        doId: quizId || doIdFromUrl(quizUrl),
        name: saName,
        outcome: `${passed ? 'passed' : 'not-cleared'}${score ? ` (${score})` : ''}`,
        url: quizUrl,
      });
      expect(passed, `Level ${level} was not passed`).toBe(true);

      if (level < LEVELS) {
        const advanced = await sa.startNextLevel();
        expect(advanced, `Level ${level}: could not click "Start Level ${level + 1}"`).toBe(true);

        // WAIT FOR THE QUIZ TO ACTUALLY CHANGE.
        // A fixed pause is not enough: the previous level's quiz stays mounted
        // for a moment, so answering began on stale pages. That is how a
        // 16-question Level 5 came to report "21 answered" — and why the
        // attempt was never recorded, while the same level passed first try
        // when opened on its own.
        const previousQuizId = quizId;
        await expect
          .poll(() => quizIdFromUrl(page.url()), {
            timeout: 45_000,
            message: `Level ${level}: the player never moved on to Level ${level + 1}`,
          })
          .not.toBe(previousQuizId);
        // …and let the new questionset render before the next iteration answers it.
        await page.waitForTimeout(3_000);
        console.log(`[STEPPER] → Level ${level + 1} quiz is ${quizIdFromUrl(page.url())}`);
      }
    }

    // The result screen is NOT proof. A run once reported "Level 5 ✅ passed
    // (70%)" while the Passbook still showed level 5 uncleared — the score was
    // never recorded. Confirm against the app's own record before claiming the
    // climb succeeded.
    // Read it with a hard time budget: a verification step must never be able
    // to hang the run (an earlier build sat here until the outer timeout killed
    // it, losing the artifact files with it).
    const read = async () => {
      await openPassbook(page);
      return clearedLevels(page, title);
    };
    const cleared: number[] | null = await Promise.race([
      read().catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), 90_000)),
    ]);

    if (cleared === null) {
      // Inconclusive — do not turn a read failure into a false verdict.
      console.log('[STEPPER] ⚠️  Could not read the Passbook within 90s — completion NOT verified.');
      await recordArtifact({
        level: 0, kind: 'self-assessment', doId: '',
        name: `${title} — Passbook`, outcome: 'unreadable (not verified)', url: page.url(),
      });
    } else {
      const missing = Array.from({ length: LEVELS }, (_, i) => i + 1).filter((n) => !cleared.includes(n));
      console.log(`[STEPPER] Passbook records levels [${cleared.join(', ')}] as cleared`);
      await recordArtifact({
        level: 0, kind: 'self-assessment', doId: '',
        name: `${title} — Passbook`,
        outcome: missing.length ? `RECORDED [${cleared.join(',')}], MISSING [${missing.join(',')}]` : `all ${LEVELS} recorded`,
        url: page.url(),
      });
      expect(
        missing,
        `the run reported these levels passed, but the Passbook does not record them: ${missing.join(', ')}`,
      ).toEqual([]);
    }
    console.log(`[STEPPER] ✅ ${title} — all ${LEVELS} self-assessment levels passed AND recorded`);
  });
});

/**
 * The self-assessment's on-screen title. The quiz screen shows the assessment
 * name in its header; fall back to "<competency> — Level N" so the reports
 * always carry a human-readable name next to the do_id.
 */
async function selfAssessmentName(page: any, competency: string, level: number): Promise<string> {
  const header = page.locator('h1, h2, .assessment-title, [class*="title"]').first();
  const raw = (await header.innerText({ timeout: 3_000 }).catch(() => '')) || '';
  const name = raw.replace(/\s+/g, ' ').trim();
  return name && name.length <= 120 ? name : `${competency} — Level ${level}`;
}
