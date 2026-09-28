import { Page, Locator } from '@playwright/test';
import type { AnswerKey, PoolQuestion } from '../../src/utils/answer-key';
import { START_COURSE, START_LEVEL, START_NOW, DISCUSSION } from '../helpers/labels';

/**
 * Page object for the Ekshamata quiz player (self-assessment), `/viewer/quiz/`.
 *
 * DOM (identical to the mobile WebView):
 *   intro screen:  button.btn-active "Start Now!"
 *   each question: .question-wrapper
 *     h3.quiz-question                    → question text
 *     input.mdc-radio__native-control[value="Q156-a"] → the optionId
 *   primary action: button.btn-active     → "Next" / final submit
 *   result screen:  button "Go back to home", "Start Level N", "Start learning"
 */
export class SelfAssessmentPage {
  constructor(private readonly page: Page) {}

  get primaryBtn(): Locator { return this.page.locator('button.btn-active'); }
  // Also matches the Hindi UI: "लेवल N शुरू करें" (Start Level N), "होम स्क्रीन पर वापस जाएं"
  // (Go back to home), "सीखना शुरू करें" (Start Learning).
  get startNextLevelBtn(): Locator { return this.page.getByRole('button', { name: /start(?:\s+next)?\s+level|next\s+level|लेवल\s*\d+\s*शुरू/i }); }
  get goHomeBtn(): Locator { return this.page.getByRole('button', { name: /go back to home|होम स्क्रीन पर वापस|होम.*वापस जा/i }); }
  /** On the FAIL result — "Start Learning" / "Start Course" launches the mapped course. */
  get startCourseBtn(): Locator { return this.page.getByRole('button', { name: START_COURSE }); }

  get radios(): Locator { return this.page.locator('input.mdc-radio__native-control'); }

  /**
   * Click "Start Now!" on the quiz intro (English or Hindi "अभी शुरू करें").
   *
   * The discussion widget on the same screen has a button ending in the same
   * words ("बातचीत शुरू करें" — start a conversation), and it is often the
   * smaller/earlier element, so a plain text match opens the discussion form
   * instead of the assessment. Every candidate is filtered through DISCUSSION.
   */
  /**
   * Get from wherever we are into the questions.
   *
   * @param targetLevel which level to open, when the competency presents a LEVEL
   *   LIST instead of going straight to the quiz. Optional: omitted, the first
   *   level is taken, and every existing caller keeps its old behaviour.
   */
  async startNow(targetLevel?: number): Promise<void> {
    await this.clickStartNowButtons();

    // Some competencies do not open the quiz at all — they open a list of
    // levels ("Level 1 : … 12 Questions 70% Required") that has no Start Now on
    // it. That made the run sit on the list, answer nothing, and read the "70%
    // Required" pass mark as if it were a score. Only runs when there are still
    // no questions, so the ordinary Start Now flow is untouched.
    const haveQuestions = await this.radios.first().isVisible({ timeout: 1_500 }).catch(() => false);
    if (!haveQuestions && await this.openLevelFromList(targetLevel)) {
      await this.clickStartNowButtons();
    }

    // Wait for the questions (radios) to actually render before we answer.
    await this.radios.first().waitFor({ state: 'attached', timeout: 20_000 }).catch(() => {});
    await this.page.waitForTimeout(1_500);
  }

  /** The original Start Now hunt, unchanged — just named so it can be re-run. */
  private async clickStartNowButtons(): Promise<void> {
    for (let i = 0; i < 6; i++) {
      if (await this.radios.first().isVisible({ timeout: 1_000 }).catch(() => false)) break;
      const candidates = this.page.getByRole('button', { name: START_NOW });
      const n = await candidates.count().catch(() => 0);
      let clicked = false;
      for (let k = 0; k < n; k++) {
        const b = candidates.nth(k);
        const label = ((await b.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
        if (DISCUSSION.test(label)) continue;            // the conversation box, not the quiz
        if (!(await b.isVisible({ timeout: 1_000 }).catch(() => false))) continue;
        await b.click().catch(() => {});
        clicked = true;
        break;
      }
      if (!clicked) await this.clickByText([START_NOW]);
      await this.page.waitForTimeout(1_500);
    }
  }

  /**
   * Open one level from a competency's LEVEL LIST, if that is what is on screen.
   *
   * Returns false immediately when questions are already showing or no level
   * entries exist, so this is a no-op for the competencies that open their quiz
   * directly. Several shapes are tried because the list renders as quiz links on
   * some builds and as clickable rows on others.
   */
  private async openLevelFromList(targetLevel?: number): Promise<boolean> {
    if (await this.radios.first().isVisible({ timeout: 1_000 }).catch(() => false)) return false;

    // "Level 2 :" / "स्तर 2" — anchored to the number so Level 1 never matches Level 10.
    const levelRe = targetLevel
      ? new RegExp(`level\\s*${targetLevel}\\s*[:.\\s]|स्तर\\s*${targetLevel}`, 'i')
      : /level\s*\d|स्तर\s*\d/i;
    const quizLinks = this.page.locator('a[href*="/viewer/quiz/"]');

    const candidates = [
      quizLinks.filter({ hasText: levelRe }).first(),
      this.page.getByRole('button', { name: levelRe }).first(),
      this.page.locator('mat-card, li, [class*="level" i], [class*="card" i]').filter({ hasText: levelRe }).last(),
      quizLinks.first(),
    ];

    for (const candidate of candidates) {
      if (!(await candidate.isVisible({ timeout: 1_500 }).catch(() => false))) continue;
      const label = ((await candidate.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      await candidate.scrollIntoViewIfNeeded().catch(() => {});
      await candidate.click().catch(() => {});
      await this.page.waitForTimeout(2_500);

      const opened = (await this.radios.first().isVisible({ timeout: 4_000 }).catch(() => false))
        || (await this.page.getByRole('button', { name: START_NOW }).first()
          .isVisible({ timeout: 1_500 }).catch(() => false));
      if (opened) {
        console.log(`[quiz] opened from the level list: "${label}"`);
        return true;
      }
    }
    return false;
  }

  /** Click "Start Level N+1" on the result (role match, then visible-text fallback). */
  async startNextLevel(): Promise<boolean> {
    const btn = this.startNextLevelBtn.first();
    if (await btn.isVisible({ timeout: 15_000 }).catch(() => false)) { await btn.click().catch(() => {}); return true; }
    if (await this.clickByText([START_LEVEL])) return true;
    // Nothing matched. Say WHAT was on screen instead of just "false": a label
    // this suite has not seen (a new wording, or a Hindi one in a word order we
    // did not expect) is the usual reason a climb stops between levels, and
    // guessing at it from a screenshot wastes a whole run.
    const seen = await this.page.evaluate(() => {
      const vis = (e: Element) => (e as HTMLElement).offsetParent !== null;
      return Array.from(document.querySelectorAll('button, a, [role="button"], .btn-active'))
        .filter(vis)
        .map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 12);
    }).catch(() => [] as string[]);
    console.log(`[SA] no "Start Level" button matched. Buttons on screen: ${seen.map((s) => `"${s}"`).join(', ') || '(none visible)'}`);
    return false;
  }

  /** Click the first VISIBLE element whose text matches any pattern (any tag).
   *  Reliable for non-Latin labels where role/name matching is flaky.
   *
   *  Two whole regions are off limits:
   *   • the DISCUSSION widget — its buttons end in the same words as the quiz's
   *     ("बातचीत शुरू करें" vs "अभी शुरू करें");
   *   • `app-player-navigation-widget` — the COURSE player's own Previous/Next,
   *     which move to the next MODULE. Clicking that instead of the quiz's own
   *     Next abandons the assessment after one question, which is exactly how a
   *     22-question quiz came to report "answered 1".
   */
  async clickByText(patterns: RegExp[]): Promise<boolean> {
    const sources = patterns.map((p) => p.source);
    return this.page.evaluate(({ srcs, skip }: { srcs: string[]; skip: string }) => {
      const res = srcs.map((s) => new RegExp(s, 'i'));
      const avoid = new RegExp(skip, 'i');
      const vis = (e: Element) => (e as HTMLElement).offsetParent !== null;
      const OUTSIDE = 'app-player-navigation-widget, .player-navigation, [class*="player-nav"]';
      const els = Array.from(document.querySelectorAll('button, a, [role="button"], .btn, .btn-active, span, div'));
      const cand = els.filter((e) => {
        if (!vis(e) || e.closest(OUTSIDE)) return false;
        const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
        return res.some((r) => r.test(t)) && !avoid.test(t);
      }).sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
      if (!cand) return false;
      const btn = (cand.closest('button, a, [role="button"], .btn-active') as HTMLElement) || (cand as HTMLElement);
      if ((btn as HTMLButtonElement).disabled) return false;   // a disabled Next is not a click
      btn.click();
      return true;
    }, { srcs: sources, skip: DISCUSSION.source }).catch(() => false);
  }

  /**
   * Select the correct option for EVERY question rendered in the DOM.
   *
   * Radios are grouped by question-id (the "Q109" prefix of the input `value`).
   * For each question we first try to click the radio whose `value` is a known
   * correct optionId; if the player re-lettered/subset the options (mixed quizzes
   * do this), we fall back to matching the option's TEXT against the key.
   * Returns how many questions were answered.
   */
  async answerAllInDom(key: AnswerKey): Promise<number> {
    const entries = [...key.byQid].map(([qid, k]) => [qid, { ids: [...k.correctIds], texts: [...k.correctTexts] }]);
    return this.page.evaluate((raw: any[]) => {
      const norm = (s: string) =>
        (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim().toLowerCase();
      const byQid = new Map<string, { ids: string[]; texts: string[] }>(raw);
      const qidOf = (v: string) => { const m = String(v).match(/^(Q\d+)/i); return m ? m[1] : String(v).split('-')[0]; };
      const optTextOf = (r: Element) => {
        const box = r.closest('mat-radio-button, .quiz-radio-button, label, .mdc-form-field, .option') as HTMLElement | null;
        return norm(box?.textContent || '');
      };

      const radios = Array.from(document.querySelectorAll('input.mdc-radio__native-control')) as any[];
      const groups = new Map<string, any[]>();
      for (const r of radios) {
        const qid = qidOf(r.value);
        if (!groups.has(qid)) groups.set(qid, []);
        groups.get(qid)!.push(r);
      }

      let count = 0;
      const unmatched: string[] = [];
      for (const [qid, rs] of groups) {
        const info = byQid.get(qid);
        if (!info) continue; // question not in the artifact — cannot determine
        // 1) exact optionId match
        let pick = rs.find((r) => info.ids.includes(r.value));
        // 2) fall back to option-text match (handles re-lettering)
        if (!pick) {
          pick = rs.find((r) => {
            const t = optTextOf(r);
            return t && info.texts.some((ct) => ct && (t === ct || t.includes(ct) || ct.includes(t)));
          });
        }
        if (pick) { pick.click(); count++; }
      }
      return count;
    }, entries);
  }

  /** Click the primary button (Next/Submit) until the result screen appears. */
  private async navigateToResult(maxSteps = 12): Promise<void> {
    for (let i = 0; i < maxSteps; i++) {
      if (await this.isResult()) {
        if (process.env.QUIZ_DEBUG) console.log(`[quiz] result screen reached at step ${i}`);
        break;
      }
      const btn = this.primaryBtn.first();
      if (!(await btn.isVisible().catch(() => false))) break;
      await btn.click().catch(() => {});
      await this.page.waitForTimeout(2_000);
    }
  }

  /** True once the post-submit result screen is shown (English or Hindi UI).
   *  NOTE: do NOT match "परिणाम" (the Results TAB label, present on every quiz
   *  screen incl. the intro) — only genuine result-screen phrases. */
  async isResult(): Promise<boolean> {
    // The IN-COURSE quiz renders inside an iframe, so the top document holds
    // none of the result text — only its controls. "Retake quiz" + "Continue"
    // are the tell, and the score text is read from the frames themselves.
    const framed = await this.page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('button, [role="button"]'))
        .map((b) => (b.textContent || '').replace(/\s+/g, ' ').trim());
      return labels.some((x) => /फिर\s*से\s*लें|retake|पुनः\s*प्रयास/i.test(x))
        && labels.some((x) => /जारी\s*रखें|continue/i.test(x));
    }).catch(() => false);
    if (framed) return true;

    // A question on screen means we are still ANSWERING, whatever any label
    // says. This guard comes first because the quiz player's own header reads
    // "Assessment / Results" and renders directly above question 1 of 5 — the
    // text match below therefore declared the result screen before a single
    // answer had been given, so every level scored 0 and fell to its course.
    if (await this.radios.first().isVisible().catch(() => false)) return false;

    // A genuine result STATES AN OUTCOME. The bare words "Assessment Results"
    // are that header and mean nothing on their own — the same trap the Hindi
    // "परिणाम" tab was already known for.
    const VERDICT = /(congratulation|not\s*cleared|बधाई हो|पास हो गया|पूरा कर लिया|पास नहीं|क्लियर नहीं|उत्तीर्ण नहीं)/i;
    for (const f of this.page.frames()) {
      const txt = (await f.locator('body').innerText().catch(() => '')) || '';
      if (VERDICT.test(txt) || /आपका\s*स्कोर|your\s*score/i.test(txt)) return true;
    }
    if (await this.goHomeBtn.isVisible().catch(() => false)) return true;
    const body = (await this.page.locator('body').innerText().catch(() => '')) || '';
    // The per-question feedback also says "बधाई हो!" — treating that as the
    // result screen ends a quiz after its first question.
    if (/सही\s*उत्तर|correct\s*answer/i.test(body) && !/मूल्यांकन\s*परिणाम|assessment\s*results/i.test(body)) return false;
    const words = /(not cleared|assessment results|congratulation|बधाई हो|पास हो गया|पास नहीं हुआ|क्लियर नहीं|पूरा कर लिया)/i.test(body);
    return words && /\d+\s*%/.test(body);
  }

  /** The result screen text (e.g. "Congratulations! Level 1 passed ..."). */
  async resultText(): Promise<string> {
    const body = (await this.page.locator('body').innerText().catch(() => '')) || '';
    const m = body.match(/Assessment Results([\s\S]*?)(Go back to home|$)/i);
    return (m ? m[1] : body).replace(/\s+/g, ' ').trim();
  }

  /**
   * The score shown on the result screen (e.g. "40%"), or ''. Without this a
   * failure only says "not cleared" — the score tells you HOW many answers
   * missed, which separates a bad answer key from an unregistered click.
   */
  async resultScore(): Promise<string> {
    const raw = ((await this.page.locator('body').innerText().catch(() => '')) || '');
    // The level list that stays behind the quiz repeats "70% Required" for every
    // level, and it comes FIRST in the document — so the old first-percentage
    // read reported the pass mark as if it were the learner's score, making a
    // 0-answer run look like a 70%. Drop the pass marks before reading.
    const body = raw.replace(/\d{1,3}\s*%\s*(required|आवश्यक)/gi, ' ');
    const near = body.match(/(?:your\s*score|score|आपका\s*स्कोर|स्कोर)\D{0,20}(\d{1,3})\s*%/i);
    if (near) return `${near[1]}%`;
    return (body.match(/(\d{1,3})\s*%/) || [])[0] || '';
  }

  /** True if the assessment was passed/cleared (English or Hindi UI). */
  async passed(): Promise<boolean> {
    const body = ((await this.page.locator('body').innerText().catch(() => '')) || '');
    const en = /(congratulation|passed|cleared)/i.test(body) && !/not cleared/i.test(body);
    // Hindi: "बधाई हो" (congrats), "पास हो गया" (passed), "पूरा कर लिया" (completed);
    // NOT: "पास नहीं" / "क्लियर नहीं" / "उत्तीर्ण नहीं" / "नहीं हुआ" (not cleared).
    const hi = /(बधाई हो|पास हो गया|पूरा कर लिया)/.test(body) && !/(पास नहीं|क्लियर नहीं|उत्तीर्ण नहीं|नहीं हुआ)/.test(body);
    return en || hi;
  }

  /** True if the assessment was NOT cleared (deliberate/failed attempt). */
  async failed(): Promise<boolean> {
    const body = ((await this.page.locator('body').innerText().catch(() => '')) || '');
    return /not cleared|पास नहीं|क्लियर नहीं|उत्तीर्ण नहीं|नहीं हुआ/i.test(body);
  }

  /**
   * Select a WRONG option for every question rendered in the DOM, to deliberately
   * fail the assessment. Picks, per question, a radio that is NOT a known-correct
   * id/text; for questions absent from the key it picks the first option (which the
   * mostly-wrong answers still keep well under the 60% pass line). Returns # answered.
   */
  async answerAllWrongInDom(key: AnswerKey): Promise<number> {
    const entries = [...key.byQid].map(([qid, k]) => [qid, { ids: [...k.correctIds], texts: [...k.correctTexts] }]);
    return this.page.evaluate((raw: any[]) => {
      const norm = (s: string) =>
        (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim().toLowerCase();
      const byQid = new Map<string, { ids: string[]; texts: string[] }>(raw);
      const qidOf = (v: string) => { const m = String(v).match(/^(Q\d+)/i); return m ? m[1] : String(v).split('-')[0]; };
      const optTextOf = (r: Element) => {
        const box = r.closest('mat-radio-button, .quiz-radio-button, label, .mdc-form-field, .option') as HTMLElement | null;
        return norm(box?.textContent || '');
      };

      const radios = Array.from(document.querySelectorAll('input.mdc-radio__native-control')) as any[];
      const groups = new Map<string, any[]>();
      for (const r of radios) {
        const qid = qidOf(r.value);
        if (!groups.has(qid)) groups.set(qid, []);
        groups.get(qid)!.push(r);
      }

      let count = 0;
      for (const [qid, rs] of groups) {
        const info = byQid.get(qid);
        const isCorrect = (r: any) =>
          !!info && (info.ids.includes(r.value) || info.texts.some((ct) => { const t = optTextOf(r); return t && ct && (t === ct || t.includes(ct) || ct.includes(t)); }));
        const wrong = rs.find((r) => !isCorrect(r)) || rs[0];
        if (wrong) { wrong.click(); count++; }
      }
      return count;
    }, entries);
  }

  /**
   * Answer all questions correctly, then submit to the result. Returns # correct.
   *
   * PER-PAGE: the web player paginates ONE question per page, so we answer the
   * question currently in the DOM, click the primary button (Next / final
   * Submit), and repeat until the result screen. `answerCurrentPage` matches the
   * on-screen question against the real S3 key by optionId AND by option text,
   * so it works whether or not the player re-letters options.
   */
  async completeWithKey(
    key: AnswerKey,
    maxSteps = 40,
    refetchKey?: () => Promise<AnswerKey | null>,
    /** Which level to open when the competency shows a level list. Optional. */
    targetLevel?: number,
  ): Promise<number> {
    let cur = key;
    return this.runQuiz(async () => {
      let n = await this.answerCurrentPage(cur);
      // If a page couldn't be answered (its questionset loaded only as the quiz
      // advanced), re-fetch the (accumulated) key and try that page once more.
      if (n === 0 && refetchKey) {
        const fresh = await refetchKey().catch(() => null);
        if (fresh) { cur = fresh; n = await this.answerCurrentPage(cur); }
      }
      return n;
    }, maxSteps, targetLevel);
  }

  /**
   * Are we inside the COURSE player (an in-course quiz), rather than on a
   * standalone competency self-assessment?
   *
   * The two look alike but behave differently, and the difference matters:
   * the in-course quiz shows a Submit from its first question and pages via a
   * per-question feedback screen, while the self-assessment enables Submit only
   * on its last page. The course player's own module nav is the reliable tell —
   * a standalone self-assessment has none.
   */
  async inCoursePlayer(): Promise<boolean> {
    return this.page.evaluate(() =>
      Boolean(document.querySelector('app-player-navigation-widget, .player-navigation, [class*="player-nav"]'))).catch(() => false);
  }

  /**
   * The per-question FEEDBACK screen the quiz shows after each answer:
   * "बधाई हो!" / "सही उत्तर: …" (or the wrong-answer variant) and a single
   * "अगला" button. It is not the result screen and it carries no question —
   * the only thing to do on it is press Next, and the quiz will not advance
   * until you do.
   */
  async isAnswerFeedback(): Promise<boolean> {
    const body = ((await this.page.locator('body').innerText().catch(() => '')) || '');
    if (/मूल्यांकन\s*परिणाम|assessment\s*results/i.test(body)) return false;  // the real result
    return /सही\s*उत्तर|correct\s*answer|आपका\s*उत्तर/i.test(body);
  }

  /**
   * Click the quiz's OWN Submit — never the course player's nav.
   *
   * In the IN-COURSE quiz this is a PER-QUESTION control: answer, "सबमिट",
   * feedback, "अगला", next question. Treating it as the final submit ended the
   * quiz on question one. In a standalone self-assessment the same label really
   * does finish the quiz, which is why the two flows are walked differently.
   */
  async clickQuizSubmit(): Promise<boolean> {
    return this.page.evaluate(() => {
      const OUTSIDE = 'app-player-navigation-widget, .player-navigation, [class*="player-nav"]';
      const vis = (e: Element) => (e as HTMLElement).offsetParent !== null;
      const label = (e: Element) => (e.textContent || '').replace(/\s+/g, ' ').trim();
      const isSubmit = (t: string) => /^(submit|सबमिट|सबमिट करें|जमा|जमा करें)$/i.test(t);
      const hits = Array.from(document.querySelectorAll('button, [role="button"], .btn-active'))
        .filter((b) => vis(b) && !b.closest(OUTSIDE) && !(b as HTMLButtonElement).disabled && isSubmit(label(b)))
        .sort((a, b) => label(a).length - label(b).length);
      if (!hits.length) return false;
      (hits[0] as HTMLElement).click();
      return true;
    }).catch(() => false);
  }

  /**
   * Click the quiz's OWN Next / अगला — never the course player's module nav,
   * which sits in app-player-navigation-widget and would abandon the quiz.
   *
   * The label is matched as a FRAGMENT: a Material button often carries an icon
   * ligature in its text ("arrow_forward अगला"), and an exact-match test found
   * nothing on such a button — the loop then decided there was no way forward
   * and submitted a one-answer quiz.
   */
  async clickQuizNext(): Promise<boolean> {
    const hit = await this.page.evaluate(() => {
      const OUTSIDE = 'app-player-navigation-widget, .player-navigation, [class*="player-nav"]';
      const vis = (e: Element) => (e as HTMLElement).offsetParent !== null;
      const label = (e: Element) => (e.textContent || '').replace(/\s+/g, ' ').trim();
      const isNext = (t: string) => /(^|\s|>)(next|अगला|आगे)(\s|$|<)/i.test(t) || /^(next|अगला|आगे)$/i.test(t);
      const cands = Array.from(document.querySelectorAll('button, [role="button"], .btn-active'))
        .filter((b) => vis(b) && !b.closest(OUTSIDE) && !(b as HTMLButtonElement).disabled);
      // Prefer the shortest label — "अगला" over a whole toolbar that contains it.
      const hits = cands.filter((b) => isNext(label(b))).sort((a, b) => label(a).length - label(b).length);
      if (!hits.length) {
        return { clicked: false, seen: cands.map(label).filter(Boolean).slice(0, 8) };
      }
      (hits[0] as HTMLElement).click();
      return { clicked: true, seen: [label(hits[0])] };
    }).catch(() => ({ clicked: false, seen: [] as string[] }));

    if (!hit.clicked && process.env.QUIZ_DEBUG) {
      console.log(`[quiz] no quiz Next among: ${hit.seen.map((s) => `"${s}"`).join(', ') || '(no enabled buttons)'}`);
    }
    return hit.clicked;
  }

  /**
   * Per-page quiz runner: answer the current page via `answerPage`, click Next /
   * final Submit, and repeat until the result screen. Shared by pass (correct
   * answers) and fail (wrong answers) so both handle the paginated player + the
   * flaky "unable to submit" the same way.
   */
  private async runQuiz(answerPage: () => Promise<number>, maxSteps: number, targetLevel?: number): Promise<number> {
    await this.startNow(targetLevel);
    let answered = 0;

    for (let step = 0; step < maxSteps; step++) {
      if (await this.isResult()) break;

      await this.radios.first().waitFor({ state: 'attached', timeout: 8_000 }).catch(() => {});
      const visRadios = await this.page.evaluate(() => (Array.from(document.querySelectorAll('input.mdc-radio__native-control, input[type="radio"]')) as HTMLElement[]).filter((r) => (r.closest('label,.mdc-form-field,mat-radio-button,li') as HTMLElement)?.offsetParent !== null || r.offsetParent !== null).length).catch(() => -1);
      const pageAnswered = await answerPage();
      answered += pageAnswered;
      if (process.env.QUIZ_DEBUG) console.log(`[quiz] step ${step}: visibleRadios=${visRadios} answered=${pageAnswered}`);

      // After each answer the quiz shows its feedback ("सही उत्तर: …") and waits
      // for Next. Clicking the quiz's own button here is what walks the whole
      // quiz; the loop used to fall through to a text search that could hit the
      // PLAYER's Next and leave the assessment after one question.
      // ── IN-COURSE QUIZ: answer → सबमिट → feedback → अगला → next question ──
      //
      // Recorded from the real portal. "सबमिट" here submits THAT QUESTION, not
      // the quiz, so the old "Submit means we are done" reading ended a
      // 22-question assessment on question one and left the course at 86%.
      // A standalone self-assessment keeps the original flow further below.
      if (await this.inCoursePlayer()) {
        const submitted = await this.clickQuizSubmit();
        if (submitted) await this.page.waitForTimeout(1_200);
        if (await this.isResult()) {
          if (process.env.QUIZ_DEBUG) console.log(`[quiz] step ${step}: result screen after submit`);
          break;
        }
        const moved = await this.clickQuizNext();
        if (process.env.QUIZ_DEBUG) {
          console.log(`[quiz] step ${step}: submit=${submitted} → next=${moved}`);
        }
        if (submitted || moved) { await this.page.waitForTimeout(1_200); continue; }
        console.log(`[quiz] stopping at step ${step}: neither the quiz's Submit nor its Next could be clicked`);
        break;
      }

      const submitBtn = this.page.getByRole('button', { name: /^(submit|जमा करें|सबमिट करें|सबमिट|जमा)$/i }).first();
      const submitReady = (await submitBtn.isVisible().catch(() => false)) && !(await submitBtn.isDisabled().catch(() => false));
      if (submitReady) {
        if (process.env.QUIZ_DEBUG) console.log(`[quiz] step ${step}: → Submit (no Next available)`);
        // Submit can transiently fail ("Something went wrong! Unable to submit") — retry.
        for (let attempt = 1; attempt <= 4; attempt++) {
          await submitBtn.click().catch(() => {});
          await this.page.waitForTimeout(1_500);
          const confirm = this.page.getByRole('button', { name: /^(yes|ok|confirm|proceed|submit assessment)$/i }).first();
          if (await confirm.isVisible({ timeout: 1_500 }).catch(() => false)) await confirm.click().catch(() => {});
          await this.page.waitForTimeout(1_500);
          const body = ((await this.page.locator('body').innerText().catch(() => '')) || '');
          if (await this.isResult()) break;
          if (/something went wrong|unable to submit|try again/i.test(body)) {
            await this.page.getByRole('button', { name: /^x$|close/i }).first().click({ timeout: 1_500 }).catch(() => {});
            await this.page.waitForTimeout(1_500);
            continue;
          }
          break;
        }
        break;
      }

      // Neither: last resort, the old text search (still never the player nav).
      const clicked = await this.clickByText([/^next$/i, /अगला/, /आगे/]);
      if (!clicked) {
        console.log(`[quiz] stopping at step ${step}: no Next or Submit of the quiz's own could be clicked`);
        break;
      }
      await this.page.waitForTimeout(1_500);
    }

    for (let i = 0; i < 6 && !(await this.isResult()); i++) await this.page.waitForTimeout(1_500);
    return answered;
  }

  /**
   * Answer the question(s) rendered on the CURRENT page.
   *
   * IMPORTANT: the rendered quiz RE-ASSIGNS question ids to its randomly-chosen
   * subset (rendered "Q101" is a different question than the key's "Q101"), and
   * the per-question text is not reliably in the radio's container — so matching
   * by optionId or by question text both fail on some competencies (scored ~17%).
   *
   * The robust key is the OPTION SET: for each rendered question we find the pool
   * question whose option texts overlap the rendered options, then click the
   * option whose text matches that pool question's correct answer. Falls back to
   * byQid id/text only if no option-set match is found.
   */
  async answerCurrentPage(key: AnswerKey): Promise<number> {
    const { count, unmatched, picks } = await this.pickPerQuestion(key, /* wrong */ false);
    for (const u of unmatched) {
      let d: any = null; try { d = JSON.parse(u); } catch { /* plain string */ }
      if (!d) { console.log(`[quiz] ⚠️  UNANSWERED: "${u}"`); continue; }
      console.log(`[quiz] ⚠️  UNANSWERED (optionScore ${d.bestScore}/${d.strong} needed) q="${d.stem}"`);
      (d.rendered || []).forEach((r: string, i: number) => console.log(`[quiz]        rendered[${i}]: ${r}`));
    }
    if (process.env.QUIZ_DEBUG) {
      for (const p of picks ?? []) {
        const ok = p.expected.some((e: string) => p.picked.includes(e) || e.includes(p.picked));
        console.log(`[quiz] ${ok ? '✓' : '✗ MISMATCH'} cand=${p.candidates} q="${p.stem}"`);
        if (!ok) console.log(`[quiz]     picked   : ${p.picked}
[quiz]     key says : ${p.expected.join(' | ')}`);
      }
    }
    return count;
  }

  /**
   * Shared per-question picker. `wrong=false` clicks the correct option (pass);
   * `wrong=true` clicks a definitively-incorrect option (deliberate fail).
   */
  private async pickPerQuestion(key: AnswerKey, wrong: boolean): Promise<{ count: number; unmatched: string[]; picks?: any[] }> {
    const byQid = [...key.byQid].map(([qid, k]) => [qid, { ids: [...k.correctIds], texts: [...k.correctTexts] }]);
    const pool = key.pool.map((p) => ({ q: p.question, opts: p.options.map((o) => ({ text: o.text, isCorrect: !!o.isCorrect })) }));
    return this.page.evaluate((args: any) => {
      const { byQidRaw, pool, wrong } = args;
      const norm = (s: string) =>
        (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&hellip;/gi, '')
          .toLowerCase().replace(/[।?.,!:_\-\s]+/g, ' ').trim();
      const byQid = new Map<string, { ids: string[]; texts: string[] }>(byQidRaw);
      const qidOf = (v: string) => { const m = String(v).match(/^(Q\d+)/i); return m ? m[1] : String(v).split('-')[0]; };
      const labelText = (r: Element) => {
        const box = r.closest('mat-radio-button, .quiz-radio-button, label, .mdc-form-field, .option, .question-wrapper li') as HTMLElement | null;
        return norm(box?.textContent || '');
      };
      const eq = (a: string, b: string) => !!a && !!b && (a === b || (a.length > 3 && b.length > 3 && (a.includes(b) || b.includes(a))));
      // Stems are long free text. Containment alone let a SHORT pool stem claim
      // a much longer rendered one (and answer it with the wrong option), so
      // require comparable lengths as well.
      const stemEq = (a: string, b: string) => {
        if (!a || !b) return false;
        if (a === b) return true;
        if (!(a.includes(b) || b.includes(a))) return false;
        const short = Math.min(a.length, b.length);
        const long = Math.max(a.length, b.length);
        return short / long >= 0.6;
      };

      // The rendered QUESTION STEM for a group of radios = the text of their
      // nearest common ancestor, minus the option texts. Needed to tell apart
      // questions that share an option set (e.g. every True/False question).
      const stemOf = (rs: HTMLInputElement[]): string => {
        let anc: HTMLElement | null = rs[0].closest('.question-wrapper, [class*="question"], .mcq, form, section, li') as HTMLElement | null;
        while (anc && !rs.every((r) => anc!.contains(r))) anc = anc.parentElement;
        if (!anc) anc = rs[0].closest('div') as HTMLElement | null;
        if (!anc) return '';
        // If that ancestor also holds OTHER questions' radios, its text is a
        // concatenation of several stems. A merged mega-stem is worse than no
        // stem: it substring-matches an unrelated pool entry, which then answers
        // this question with that entry's correct option. Bail out instead.
        if (radios.some((r) => !rs.includes(r) && anc!.contains(r))) return '';
        // Hidden siblings (answered / not-yet-shown questions) stay in the DOM,
        // so read VISIBLE text only.
        const visibleText = (el: HTMLElement): string => {
          if (el !== anc && el.offsetParent === null) return '';
          let out = '';
          for (const node of Array.from(el.childNodes)) {
            if (node.nodeType === 3) out += ' ' + (node.textContent || '');
            else if (node.nodeType === 1) out += ' ' + visibleText(node as HTMLElement);
          }
          return out;
        };
        let t = norm(visibleText(anc));
        for (const r of rs) { const ot = labelText(r); if (ot && ot.length > 2) t = t.split(ot).join(' '); }
        return t.replace(/\s+/g, ' ').trim();
      };

      // Pre-normalise the pool's stem + option sets + which texts are correct.
      const poolN = (pool as any[]).map((p) => ({
        q: norm(p.q || ''),
        opts: p.opts.map((o: any) => norm(o.text)),
        correct: p.opts.filter((o: any) => o.isCorrect).map((o: any) => norm(o.text)),
      }));

      const radios = (Array.from(document.querySelectorAll('input.mdc-radio__native-control, input[type="radio"]')) as HTMLInputElement[])
        .filter((r) => (r.closest('label,.mdc-form-field,mat-radio-button,li') as HTMLElement)?.offsetParent !== null || (r as HTMLElement).offsetParent !== null);
      if (!radios.length) return { count: 0, unmatched: [] as string[], picks: [] as any[] };

      const groups = new Map<string, HTMLInputElement[]>();
      for (const r of radios) {
        const qid = qidOf(r.value);
        if (!groups.has(qid)) groups.set(qid, []);
        groups.get(qid)!.push(r);
      }

      let count = 0;
      const unmatched: string[] = [];
      const picks: any[] = [];
      for (const [qid, rs] of groups) {
        const rendered = rs.map((r) => labelText(r));
        // 1) PRIMARY: identify THIS question in the pool, then take its correct
        //    option(s). We combine two signals:
        //      • OPTION SET — how many rendered options a pool entry contains
        //        (near-exact match; the merged pool spans every level, so a weak
        //        overlap would borrow a different-but-similar question's answer).
        //      • QUESTION STEM — the on-screen question text. Essential when the
        //        option set can't identify it: every True/False question shares
        //        the same two options, so options alone are a coin-flip.
        const stem = stemOf(rs);
        const strong = Math.max(2, rendered.length - 1);
        let bestScore = 0;
        const scored = poolN.map((pq: any) => {
          let score = 0;
          for (const ro of rendered) if (pq.opts.some((po: string) => eq(po, ro))) score++;
          if (score > bestScore) bestScore = score;
          return { pq, score };
        });
        // Option-set candidates: entries whose options match this question near-exactly.
        let candidates = bestScore >= strong ? scored.filter((s: any) => s.score === bestScore).map((s: any) => s.pq) : [];
        // Disambiguate ties by the STEM (keeps the right one among identical option sets).
        if (stem && candidates.length > 1) {
          const byStem = candidates.filter((pq: any) => pq.q && stemEq(pq.q, stem));
          if (byStem.length) candidates = byStem;
        }
        // If options couldn't identify it, fall back to a pure STEM match over the whole pool.
        if (!candidates.length && stem) {
          candidates = poolN.filter((pq: any) => pq.q && stemEq(pq.q, stem));
        }
        const correctTexts = new Set<string>();
        for (const pq of candidates) for (const ct of pq.correct) if (ct) correctTexts.add(ct);

        let pick: HTMLInputElement | undefined;
        if (correctTexts.size) {
          const cts = [...correctTexts];
          const isCorrect = (r: HTMLInputElement) => { const t = labelText(r); return cts.some((ct) => eq(t, ct)); };
          pick = wrong ? (rs.find((r) => !isCorrect(r)) || rs[rs.length - 1]) : rs.find((r) => isCorrect(r));
        }
        // 2) FALLBACK: byQid id/text — ONLY when that key entry really belongs to
        //    this question. Question ids repeat across levels (every level starts
        //    at Q100), so a bare id lookup happily answered an L3 question with
        //    L2's "Q10x" option. Require the entry's own option text to be one of
        //    the rendered options; otherwise leave it unanswered so the caller
        //    re-fetches the key instead of guessing.
        if (!pick) {
          const info = byQid.get(qid);
          const belongsHere = !!info && info.texts.some((ct) => rendered.some((ro) => eq(ro, norm(ct))));
          const isCorrect = (r: HTMLInputElement) => !!info && (info.ids.includes(r.value)
            || info.texts.some((ct) => eq(labelText(r), norm(ct))));
          if (info && belongsHere) pick = wrong ? (rs.find((r) => !isCorrect(r)) || rs[rs.length - 1]) : rs.find((r) => isCorrect(r));
        }
        // last resort for a fail: any non-first option; for a pass: nothing (skip).
        if (!pick && wrong) pick = rs[rs.length - 1];

        if (pick) {
          picks.push({
            stem: stem.slice(0, 70),
            picked: labelText(pick).slice(0, 60),
            expected: [...correctTexts].map((t) => String(t).slice(0, 60)),
            candidates: candidates.length,
          });
          const box = pick.closest('label, .mdc-form-field, mat-radio-button, li') as HTMLElement | null;
          (box || pick).click();
          if (!pick.checked) { pick.click(); pick.checked = true; pick.dispatchEvent(new Event('change', { bubbles: true })); }
          count++;
        } else {
          // No pool entry matched this question — it is left UNANSWERED, which
          // costs the score just like a wrong answer. Surface it.
          unmatched.push(JSON.stringify({ stem: stem.slice(0, 80) || qid, rendered, bestScore, strong }));
        }
      }
      return { count, unmatched, picks };
    }, { byQidRaw: byQid, pool, wrong });
  }

  /** Deliberately FAIL: pick a WRONG option on every page, then submit. */
  async failWithKey(key: AnswerKey, maxSteps = 40, targetLevel?: number): Promise<number> {
    return this.runQuiz(() => this.answerCurrentPageWrong(key), maxSteps, targetLevel);
  }

  /**
   * Answer the CURRENT page WRONG (deliberate fail). Uses the same robust
   * OPTION-SET matching as the pass-picker to identify each question's correct
   * option, then clicks a DIFFERENT one — guaranteeing a fail even when the
   * quiz re-assigns ids.
   */
  async answerCurrentPageWrong(key: AnswerKey): Promise<number> {
    const { count } = await this.pickPerQuestion(key, /* wrong */ true);
    return count;
  }

  /** Click "Start Learning" / "Start Course" on the fail result. */
  async startCourse(): Promise<void> {
    const btn = this.startCourseBtn.first();
    await btn.waitFor({ state: 'visible', timeout: 15_000 });
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click();
  }

  /** Click "Go back to home" on the result screen. */
  async goBackToHome(): Promise<void> {
    const btn = this.goHomeBtn.first();
    await btn.waitFor({ state: 'visible', timeout: 15_000 });
    await btn.click();
  }
}

