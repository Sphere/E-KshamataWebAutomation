import { Page, Locator, expect } from '@playwright/test';
import { START_COURSE, START_SELF_ASSESSMENT, labelMatches } from '../helpers/labels';

/**
 * Page object for the Ekshamata Competency Stepper home (`/page/home`).
 *
 * The web DOM is identical to the mobile Capacitor WebView, so the selectors
 * verified in the mobile suite apply 1:1:
 *   .line-label            → "Your Learning Plan (N)"
 *   app-asha-learning      → one card per competency
 *     .asha-m-title        → competency name
 *     app-stepper .step-circle (×N) → levels
 *     button.btn-expand    → collapse/expand the card
 *     button.start-btn     → "Start Self Assessment"
 *   button.btn-underline   → "View All"
 */
export class CompetencyHomePage {
  constructor(private readonly page: Page) {}

  get cards(): Locator { return this.page.locator('app-asha-learning'); }
  get viewAllBtn(): Locator {
    // The home caps the plan at the first few cards; this reveals the rest.
    // Hindi renders it as "सभी देखें" with class .view-all-course (no <button>).
    return this.page.locator('.view-all-course, button.btn-underline')
      .or(this.page.getByText(/^\s*(view all|सभी\s*देखें)\s*$/i)).first();
  }
  get learningPlanLabel(): Locator { return this.page.locator('.line-label'); }

  /**
   * Wait until the competency list has rendered.
   *
   * A JUST-provisioned account often lands on an EMPTY home: the learning plan
   * is assembled server-side a moment after the account is created, and a page
   * rendered before it existed never re-fetches it. One flat 30s wait therefore
   * failed whole runs with "no .asha-card" on accounts that were fine seconds
   * later. Reload between waits so the backend is re-asked rather than a stale
   * page re-watched.
   */
  async waitForLoaded(totalMs = 90_000): Promise<void> {
    const deadline = Date.now() + totalMs;
    for (let attempt = 1; ; attempt++) {
      // waitFor, NOT isVisible: isVisible() is an instant check — its `timeout`
      // option does not make it wait — so the retry loop spun through dozens of
      // reloads in the time it was supposed to spend watching for one card.
      const shown = await this.page.locator('.asha-card').first()
        .waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
      if (shown) return;
      if (Date.now() >= deadline) break;
      console.log(`[home] no competency cards yet — reloading (attempt ${attempt})`);
      await this.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await this.page.waitForLoadState('networkidle').catch(() => {});
    }
    // Out of time: fail through the ORIGINAL assertion, so the error still names
    // the selector everyone recognises.
    await this.page.locator('.asha-card').first().waitFor({ state: 'visible', timeout: 5_000 });
  }

  /** The number in "Your Learning Plan (N)". */
  async learningPlanCount(): Promise<number> {
    const txt = (await this.learningPlanLabel.textContent()) ?? '';
    const m = txt.match(/\((\d+)\)/);
    return m ? parseInt(m[1], 10) : 0;
  }

  /** All competency card titles currently in the DOM. */
  async competencyTitles(): Promise<string[]> {
    return this.page.locator('.asha-m-title').allInnerTexts();
  }

  /**
   * The home LAZY-RENDERS competency cards — only the first few are in the DOM
   * until you scroll. Scroll until every card in "Your Learning Plan (N)" has
   * rendered (or the count stops growing), so we see the whole plan, not just
   * the top few. Returns the number of cards loaded.
   */
  async loadAll(): Promise<number> {
    await this.waitForLoaded();
    const want = await this.learningPlanCount().catch(() => 0);
    // The home shows only the first few cards + a "View All / सभी देखें" control
    // that reveals the whole plan. Click it (it may appear again as more load).
    for (let clicks = 0; clicks < 5; clicks++) {
      if ((await this.cards.count()) >= want && want) break;
      const va = this.viewAllBtn;
      if (!(await va.isVisible().catch(() => false))) break;
      await va.scrollIntoViewIfNeeded().catch(() => {});
      await va.click().catch(() => {});
      await this.page.waitForTimeout(2_000);
      await this.waitForLoaded().catch(() => {});
    }
    // Then scroll to trigger any lazy render of the expanded list.
    let last = -1, stable = 0;
    for (let i = 0; i < 60; i++) {
      const n = await this.cards.count();
      if (want && n >= want) return n;
      if (n === last) { if (++stable >= 4) return n; } else stable = 0;
      last = n;
      await this.cards.last().scrollIntoViewIfNeeded().catch(() => {});
      await this.page.mouse.wheel(0, 1400).catch(() => {});
      await this.page.waitForTimeout(500);
    }
    return this.cards.count();
  }

  /** The card whose title contains `name` (case-insensitive), or null. */
  private card(name: string): Locator {
    return this.cards.filter({ has: this.page.locator('.asha-m-title', { hasText: new RegExp(escapeRe(name), 'i') }) }).first();
  }

  /**
   * Expand a competency card (if collapsed) and click its action button.
   *
   * The button is `button.start-btn` whatever it says, and what it says changes
   * with the card's state and the language: "Start Self Assessment" /
   * "शुरू करें स्वयं मूल्यांकन" while a level is unattempted, and
   * "Start Learning" / "कोर्स शुरू करें" once a level has been failed and the
   * mapped course has to be taken. Clicking by CLASS works in every one of
   * those states; the label is only read so the log says which screen we are
   * about to land on. The text fallback exists for a build that drops the class.
   */
  private async expandAndStart(card: Locator): Promise<string> {
    await card.scrollIntoViewIfNeeded();
    const title = (await card.locator('.asha-m-title').first().textContent())?.trim() ?? '';

    let startBtn = card.locator('button.start-btn').first();
    if (!(await startBtn.isVisible().catch(() => false))) {
      // The expand toggle is a <span class="btn-expand"> (NOT a <button>), so
      // match by class only. Without expanding, the action button stays hidden
      // and we'd time out.
      const expand = card.locator('.btn-expand').first();
      if (await expand.isVisible().catch(() => false)) {
        await expand.click();
        await this.page.waitForTimeout(1_500);
      }
    }

    if (!(await startBtn.isVisible().catch(() => false))) {
      // No .start-btn: fall back to any button in this card that reads like a
      // start, in either language and either word order.
      const byText = card.getByRole('button', { name: START_SELF_ASSESSMENT })
        .or(card.getByRole('button', { name: START_COURSE })).first();
      if (await byText.isVisible().catch(() => false)) startBtn = byText;
    }

    await startBtn.waitFor({ state: 'visible', timeout: 15_000 });
    const label = ((await startBtn.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
    // Which screen this opens is decided by the label, not by us: a failed
    // level turns the assessment button into a "take the course" button.
    const opens = labelMatches(label, START_SELF_ASSESSMENT) ? 'self-assessment'
      : labelMatches(label, START_COURSE) ? 'course'
      : 'unknown';
    console.log(`[home] "${title}" → clicking "${label}" (opens: ${opens})`);
    await startBtn.click();
    return title;
  }

  /**
   * Start the self-assessment for the competency whose name matches `name`.
   * Tries the cards on screen, then "View All" if needed. Returns the title.
   */
  async startSelfAssessmentByName(name: string): Promise<string> {
    await this.waitForLoaded();
    // Cards lazy-render — load the whole plan so a competency further down the
    // list (e.g. #12 of 18) is actually in the DOM before we match it.
    await this.loadAll().catch(() => {});

    let card = this.card(name);
    if (!(await card.count()) && (await this.viewAllBtn.isVisible().catch(() => false))) {
      await this.viewAllBtn.click();
      await this.page.waitForTimeout(2_000);
      await this.waitForLoaded();
      card = this.card(name);
    }
    if (!(await card.count())) {
      const titles = await this.competencyTitles();
      // A Hindi-only competency's title changes with the language, so an English
      // name won't match — but if the plan has exactly ONE competency, use it.
      if ((await this.cards.count()) === 1) {
        console.log(`[home] "${name}" not matched by name; using the only competency: "${titles[0]}"`);
        return this.expandAndStart(this.cards.first());
      }
      throw new Error(`Competency not found on home: "${name}". Available: ${titles.join(' | ')}`);
    }
    return this.expandAndStart(card);
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
