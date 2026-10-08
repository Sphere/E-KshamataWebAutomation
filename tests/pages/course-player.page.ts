import { test, type Page } from '@playwright/test';
import { fetchRealAnswerKey, fetchKeyByDoId } from '../helpers/real-answer-key';
import { SelfAssessmentPage } from './self-assessment.page';
import { START_COURSE } from '../helpers/labels';

/**
 * Course player — completes an ENTIRE course whose resources (PDF / video /
 * content / assessment) may appear in any order. Ported from the mobile
 * course-runner (same Sunbird WebView player). Each resource is fully completed
 * before advancing; the token-free answer key is used for in-course quizzes.
 */
export type ModuleType = 'pdf' | 'video' | 'assessment' | 'content' | 'unknown';

function rid(url: string): string {
  return (url.match(/\/viewer\/(?:pdf|video|html|quiz)\/(do_\w+)/) || [])[1] || url;
}

export class CoursePlayer {
  constructor(private readonly page: Page) {}

  /** Enter the course player from the TOC overview (handles Start and Resume). */
  async startCourse(): Promise<void> {
    // Dismiss a details/competency popup ONLY when it's inside a modal/dialog —
    // never a bare page "×" (that is the player's EXIT button, which bounces us
    // out of the course to /page/home). Scope strictly to an overlay container.
    await this.page.evaluate(() => {
      const modal = document.querySelector('[role="dialog"], .modal, .mat-dialog-container, .cdk-overlay-container .popup, app-details-popup, app-competency-details');
      const scope: ParentNode = modal || document;
      const b = Array.from(scope.querySelectorAll('button')).find((x) => {
        const t = (x.textContent || '').trim();
        return /^close$/i.test(t) || (x as HTMLElement).id === 'close-btn' || (modal && /^(×|✕|✖)$/.test(t));
      });
      if (b) (b as HTMLElement).click();
    }).catch(() => {});
    // ENROL through the course's own VISIBLE banner button first. Only that button
    // calls POST /learner/course/v1/enrol; a module link (the Modules list sits in
    // the page, hidden) opens the player WITHOUT enrolling, and the portal then
    // throws every bit of progress away — a whole competency run "completed" on
    // UAT with Started (0) / Completed (0) and every course still at "Start".
    // When the button says Start (not Resume / Start Again) the enrol call MUST
    // succeed, or there is no point playing the course.
    const banner = this.page.locator('.banner-btn:visible, #start-btn:visible').first();
    if (!/\/viewer\//i.test(this.page.url())
      && await banner.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false)) {
      const label = (await banner.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      // Only a plain START means "not enrolled yet". Every other wording — Resume,
      // Start Again, जारी रखें, फिर से शुरू करें, दोबारा शुरू करें ("start again",
      // which broke a re-opened level-4 course) — is an already-enrolled course,
      // so no enrol call is expected.
      let notEnrolledYet = /^(start|start learning|start course|शुरु करो|शुरू करो|शुरू करें|कोर्स शुरू करें|पाठ्यक्रम शुरू करें)$/i.test(label)
        && !/again|resume|continue|जारी|फिर\s*से|दोबारा|पुनः/i.test(label);
      // The label can't be trusted on its own: a course already enrolled at 50%
      // still showed "शुरु करो" when re-opened to finish it, and clicking it just
      // resumes (no enrol call). So a "Start" label is confirmed against the
      // portal's enrolment record — only a course the user is NOT enrolled in
      // must produce the enrol call.
      if (notEnrolledYet) {
        const courseId = (this.page.url().match(/\/app\/toc\/([^/?]+)/) || [])[1] || '';
        const rec = courseId ? await this.enrolmentOf(courseId) : null;
        if (rec && rec.status >= 0) {
          console.log(`   ↻ "${label}" but already enrolled (${rec.pct}%) — resuming, no enrol call expected`);
          notEnrolledYet = false;
        }
      }
      const enrol = this.page.waitForResponse(
        (r) => /\/course\/v1\/enrol\b/.test(r.url()) && r.request().method() === 'POST',
        { timeout: 20_000 },
      ).then((r) => r.ok(), () => false);
      await banner.click().catch(() => {});
      if (notEnrolledYet) {
        const ok = await enrol;
        console.log(ok ? `   🎓 enrolled ("${label}" → POST /enrol OK)` : `   ❌ "${label}" clicked but the course was NOT enrolled`);
        if (!ok) {
          throw new Error(`Course not enrolled: "${label}" was clicked but no successful POST /enrol followed — `
            + 'the portal would discard all progress, so the course is not played.');
        }
      }
      await this.page.waitForURL(/\/viewer\//i, { timeout: 15_000 }).catch(() => {});
    }
    // Fallback (no banner button found): the label is matched as a FRAGMENT —
    // "कोर्स शुरू करें" in Hindi, "Start Again" on a completed course; START_COURSE
    // carries both languages' wordings. VISIBLE elements only, so a hidden module
    // link is never clicked in the banner's place.
    for (let i = 0; i < 20 && !/\/viewer\//i.test(this.page.url()); i++) {
      await this.page.evaluate((src: string) => {
        const re = new RegExp(src, 'i');
        const btn = Array.from(document.querySelectorAll('button, a')).find((b) =>
          (b as HTMLElement).offsetParent !== null && (
            (b as HTMLElement).id === 'start-btn' || (b as HTMLElement).classList?.contains('banner-btn') ||
            re.test((b.textContent || '').replace(/\s+/g, ' ').trim())));
        if (btn) (btn as HTMLElement).click();
      }, START_COURSE.source).catch(() => {});
      // poll fast so we enter /viewer/ the moment the course navigates
      await this.page.waitForURL(/\/viewer\//i, { timeout: 1_200 }).catch(() => {});
    }
    await this.page.waitForTimeout(1_500);
  }

  /** Detect the resource type currently on screen. */
  async detectType(): Promise<ModuleType> {
    const url = this.page.url();
    await this.page.waitForTimeout(1_500);
    // A <video> present means a video lecture, EVEN when the URL says /viewer/pdf
    // (the app serves some video "Lecture" modules through the pdf route).
    const info = await this.page.evaluate(() => ({
      video: document.querySelectorAll('video').length,
      // "Start Now" — English or Hindi "अभी शुरू करें". The discussion box on
      // the same screen says "बातचीत शुरू करें", which ends in the same words,
      // so it is excluded or a quiz screen is detected where there is none.
      startNow: Array.from(document.querySelectorAll('button')).some((b) => {
        const t = (b.textContent || '').replace(/\s+/g, ' ').trim();
        return /start\s*now|अभी\s*शुरू|शुरू\s*करें/i.test(t) && !/बातचीत|चर्चा|discussion/i.test(t);
      }),
      radios: document.querySelectorAll('input.mdc-radio__native-control, mat-radio-button').length,
      // question counter — English "N Questions" or Hindi "N प्रश्न"
      counters: /\d+\s*(Questions?|प्रश्न)/i.test((document.body as HTMLElement).innerText || ''),
      canvas: document.querySelectorAll('canvas').length,
    }));
    if (info.video > 0) return 'video';
    if (/\/viewer\/quiz/i.test(url) && (info.startNow || info.radios > 0 || info.counters)) return 'assessment';
    if (/\/viewer\/pdf/i.test(url) || info.canvas > 0) return 'pdf';
    if (/\/viewer\/video|\/play\//i.test(url)) return 'video';
    if (/\/viewer\/(html|content)/i.test(url)) return 'content';
    if (info.startNow || info.radios > 0 || info.counters) return 'assessment';
    return 'content';
  }

  /**
   * The module "Next" button (inside the player nav) is enabled = current
   * resource consumed. Scoped to app-player-navigation-widget so a lingering
   * level-carousel "Next" elsewhere can't give a false positive.
   */
  private async isAdvanceReady(): Promise<boolean> {
    return this.page.evaluate(() => {
      const nav = document.querySelector('app-player-navigation-widget') as HTMLElement | null;
      if (!nav) return false;
      // Module "Next" — English "Next" or Hindi "अगला" (ignore "पिछला"/Previous).
      return Array.from(nav.querySelectorAll('button')).some((b) =>
        /^(next|अगला)$/i.test(((b as HTMLElement).textContent || '').trim())
        && !(b as HTMLButtonElement).disabled && (b as HTMLElement).offsetParent !== null);
    });
  }

  /**
   * Consume a PDF: SCROLL the PDF container all the way to the bottom (the gating
   * needs the scroll to reach the end — page chevrons alone don't satisfy it),
   * flip any page chevron too, and repeat until the module "Next" enables.
   */
  async completePdf(maxMs = 120_000): Promise<void> {
    await this.page.locator('ws-widget-player-pdf, canvas').first()
      .waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
    await this.page.waitForTimeout(1_000);
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (await this.isAdvanceReady()) return; // "Next" on → PDF fully consumed → next unlocked
      await this.page.evaluate(() => {
        // drag every scrollable container inside the PDF widget to the very end
        const scope = document.querySelector('ws-widget-player-pdf') || document.body;
        const scrollables = [scope, ...Array.from(scope.querySelectorAll('*'))]
          .filter((e) => (e as HTMLElement).scrollHeight > (e as HTMLElement).clientHeight + 20) as HTMLElement[];
        for (const el of scrollables) el.scrollTop = el.scrollHeight;
        // and advance the page chevron if the viewer is paged
        const chev = Array.from(document.querySelectorAll('button')).find((b) => /chevron_right/i.test(b.textContent || ''));
        if (chev && !(chev as HTMLButtonElement).disabled) (chev as HTMLElement).click();
      }).catch(() => {});
      await this.page.waitForTimeout(700);
    }
  }

  /**
   * Complete a video: SEEK to ~85% once, then PLAY the last stretch at 3x. The
   * player registers continuous progress through the final part (so it counts as
   * watched and "Next"/"अगला" enables) without waiting for the whole video, and
   * without the seek-to-very-end that skips progress entirely. Rate/seek point
   * override via VIDEO_RATE / VIDEO_SEEK_PCT.
   */
  async completeVideo(maxWaitMs = 180_000): Promise<void> {
    const rate = Math.max(1, Number(process.env.VIDEO_RATE || 3));
    const seekPct = Math.min(0.98, Math.max(0, Number(process.env.VIDEO_SEEK_PCT || 0.85)));
    const deadline = Date.now() + maxWaitMs;
    let seeked = false;
    while (Date.now() < deadline) {
      if (await this.isAdvanceReady()) return; // already consumed → next unlocked
      const near = await this.page.evaluate((args: { rate: number; pct: number; seek: boolean }) => {
        const v = document.querySelector('video') as HTMLVideoElement | null;
        if (!v) return true;
        v.muted = true;
        try { v.playbackRate = args.rate; } catch { /* ignore */ }
        // jump to ~85% ONCE, then let it play the remaining part at 3x
        if (args.seek && isFinite(v.duration) && v.duration > 0 && v.currentTime < v.duration * args.pct) {
          try { v.currentTime = v.duration * args.pct; } catch { /* seeking may be blocked */ }
        }
        if (v.paused) v.play().catch(() => {});
        return v.ended || (isFinite(v.duration) && v.duration > 0 && v.currentTime >= v.duration - 0.8);
      }, { rate, pct: seekPct, seek: !seeked });
      seeked = true;
      if (near) {
        await this.page.evaluate(() => {
          const v = document.querySelector('video') as HTMLVideoElement | null;
          if (v) { try { v.dispatchEvent(new Event('ended')); } catch { /* ignore */ } }
        });
        await this.page.waitForTimeout(1_800);
        if (await this.isAdvanceReady()) return;
      }
      await this.page.waitForTimeout(1_500);
    }
  }

  /** Scroll/flip content until the module "Next" enables. */
  async completeContent(maxMs = 60_000): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (await this.isAdvanceReady()) return;
      await this.page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
        const chev = Array.from(document.querySelectorAll('button')).find((b) => /chevron_right/i.test(b.textContent || '') && !(b as HTMLButtonElement).disabled);
        if (chev) (chev as HTMLElement).click();
      }).catch(() => {});
      await this.page.waitForTimeout(800);
    }
  }

  /**
   * Answer an in-course assessment via the token-free key, then submit.
   *
   * The in-course assessment uses the SAME paginated player as the standalone
   * self-assessment (one question per page), so we reuse its robust per-page
   * runner — it answers the question on EACH page before clicking Next, and on
   * the final page clicks Submit with the "unable to submit" retry. (The old
   * approach answered only the first page then blind-clicked Next, which stalled
   * near the last question of a long quiz, e.g. 17 questions stuck at Q16.)
   */
  async completeAssessment(): Promise<void> {
    const sa = new SelfAssessmentPage(this.page);
    // Start the quiz FIRST so its questionsets load, THEN fetch the key — fetching
    // at the intro misses most questions of a large (e.g. 87-q) assessment.
    await sa.startNow();
    await this.page.waitForTimeout(2_000);

    // THIS assessment's own questionset, by its do_id, before anything else.
    //
    // The network-sniffed key is a POOL of every questionset seen so far, and a
    // course with two assessments fills it with the first one's questions: a
    // post-assessment then matched 1 of its 22 questions, failed, and left the
    // course at 86% with every module "consumed". Reading the id off the URL
    // fetches the right artifact deterministically, and the sniffed pool is
    // merged in behind it rather than relied upon.
    const doId = (this.page.url().match(/(do_\w+)/) || [])[1] || '';
    const freshKey = async () =>
      (await fetchKeyByDoId(this.page, doId).catch(() => null))
      || (await fetchRealAnswerKey(this.page).catch(() => null));

    const key = await freshKey();
    if (key) {
      // re-fetch per unanswered page: a paginated 87-q quiz loads questionsets as
      // it advances, so the pool keeps growing — this reaches full coverage.
      const answered = await sa.completeWithKey(key, 100, freshKey);
      console.log(`[assessment] answered ${answered} question(s)` + ` — key holds ${key.byQid.size}${doId ? `, from ${doId}` : ''}`);
      // When an assessment ends without reaching its result screen, keep the
      // evidence: the screen it stopped on is the only thing that explains why,
      // and re-running to see it costs minutes each time.
      if (!(await sa.isResult())) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const shot = `test-results/assessment-stuck-${doId || 'unknown'}-${stamp}.png`;
        await this.page.screenshot({ path: shot, fullPage: true }).catch(() => {});
        const seen = await this.page.evaluate(() => {
          const vis = (e: Element) => (e as HTMLElement).offsetParent !== null;
          const clean = (t: string | null) => (t || '').replace(/s+/g, ' ').trim();
          return {
            buttons: Array.from(document.querySelectorAll('button, [role="button"]')).filter(vis)
              .map((b) => `${clean(b.textContent)}${(b as HTMLButtonElement).disabled ? '[disabled]' : ''}`)
              .filter(Boolean).slice(0, 10),
            text: clean((document.body as HTMLElement).innerText).slice(0, 300),
          };
        }).catch(() => null);
        console.log(`[assessment] ⚠️ ended WITHOUT a result screen — saved ${shot}`);
        if (seen) {
          console.log(`[assessment] buttons: ${JSON.stringify(seen.buttons)}`);
          console.log(`[assessment] screen : ${seen.text}`);
        }
      }
    } else {
      console.log('[assessment] ⚠️ NO answer key captured → fallback first-option answers (likely fails)');
      // Fallback (no key captured): still answer PER PAGE (first option each),
      // then Next/Submit — never blind-click without answering.
      await sa.startNow(); // Hindi-aware "अभी शुरू करें" / "Start Now"
      await this.page.waitForTimeout(2_500);
      for (let i = 0; i < 60; i++) {
        // answer the current page (one option per question group)
        await this.page.evaluate(() => {
          const inputs = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"]')) as HTMLInputElement[];
          const seen = new Set<string>();
          inputs.forEach((inp) => { if (!seen.has(inp.name)) { inp.click(); seen.add(inp.name); } });
        }).catch(() => {});
        await this.page.waitForTimeout(1_000);
        const done = await this.page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button')).find((b) => /^(next|submit)$/i.test((b.textContent || '').trim()) && !(b as HTMLButtonElement).disabled);
          if (!btn) return true;
          const isSubmit = /^submit$/i.test((btn.textContent || '').trim());
          (btn as HTMLElement).click();
          return isSubmit;
        });
        await this.page.waitForTimeout(2_000);
        if (done) break;
      }
    }
    // Give the score/congratulations screen time to render before we move on.
    await this.page.waitForTimeout(3_000);
  }

  /** Complete whatever resource is on screen; returns its type. */
  async completeCurrent(): Promise<ModuleType> {
    const type = await this.detectType();
    await this.completeByType(type);
    return type;
  }

  /** Complete a resource of a known type. */
  async completeByType(type: ModuleType): Promise<void> {
    if (type === 'pdf') await this.completePdf();
    else if (type === 'video') await this.completeVideo();
    else if (type === 'assessment') await this.completeAssessment();
    else if (type === 'content') await this.completeContent();
    else await this.page.waitForTimeout(2_000);
  }

  /**
   * Advance to the next resource. Completing a resource UNLOCKS the next sidebar
   * module (its link goes `disabled` → active/enabled) and enables the module
   * "Next" button (distinct from the `chevron_right` PDF page-nav). We poll for
   * that unlock, then click the newly-unlocked module — or the enabled "Next".
   */
  async advance(seen: Set<string>): Promise<{ advanced: boolean; courseDone: boolean }> {
    const urlBefore = this.page.url();
    // dismiss non-completion popups
    await this.page.evaluate(() => {
      const labels = [/go to course/i, /^continue$/i, /^done$/i, /^ok$/i, /जारी रखें/, /कोर्स पर जाएं/, /^ठीक है$/, /^हो गया$/, /^पूर्ण$/];
      const btn = Array.from(document.querySelectorAll('button')).find((b) => labels.some((re) => re.test((b.textContent || '').trim())) && !(b as HTMLButtonElement).disabled);
      if (btn) (btn as HTMLElement).click();
    }).catch(() => {});

    // Poll up to ~50s for the gating to clear, then click the next module.
    for (let attempt = 0; attempt < 20; attempt++) {
      const action = await this.page.evaluate((seenIds: string[]) => {
        const rid = (h: string) => ((h || '').match(/(do_\w+)/) || [])[1] || '';
        // sidebar module links (carry a duration "20m" or "N Questions")
        const links = Array.from(document.querySelectorAll('a')).filter((a) =>
          /(\d+\s*m\b|\d+\s*Minutes?|\d+\s*Questions?|\d+\s*मिनट|\d+\s*प्रश्न|\d+\s*सेकंड)/i.test(((a as HTMLElement).innerText || '').trim()));
        // the next module = unlocked (not "disabled"), not the current ("content-active"), not already done
        for (const a of links) {
          const cls = String((a as HTMLElement).className || '');
          if (/disabled/.test(cls) || /content-active/.test(cls)) continue;
          const id = rid((a as HTMLAnchorElement).href);
          if (id && seenIds.includes(id)) continue;
          (a as HTMLElement).scrollIntoView({ block: 'center' });
          (a as HTMLElement).click();
          return 'sidebar';
        }
        // the module/resource "Next" button — English "Next" or Hindi "अगला".
        const isNext = (b: Element) => /^(next|अगला)$/i.test((b.textContent || '').trim())
          && !(b as HTMLButtonElement).disabled && (b as HTMLElement).offsetParent !== null;
        // prefer the player-nav widget (avoids a level-carousel Next)…
        const nav = document.querySelector('app-player-navigation-widget');
        let next = nav ? Array.from(nav.querySelectorAll('button')).find(isNext) : undefined;
        // …else a content/resource-level Next anywhere OUTSIDE the level carousel
        // (resources INSIDE a module advance via this "अगला" button).
        if (!next) {
          next = Array.from(document.querySelectorAll('button')).find((b) =>
            isNext(b) && !b.closest('app-asha-learning, app-stepper, .carousel, mat-tab-group'));
        }
        if (next) { (next as HTMLElement).click(); return 'next'; }
        // nothing clickable — is there any unlocked-unseen module left?
        const anyLeft = links.some((a) => {
          const cls = String((a as HTMLElement).className || '');
          if (/disabled/.test(cls) || /content-active/.test(cls)) return false;
          const id = rid((a as HTMLAnchorElement).href);
          return id && !seenIds.includes(id);
        });
        return anyLeft ? 'wait' : 'done';
      }, [...seen]);

      await this.page.waitForTimeout(2_500);
      if (this.page.url() !== urlBefore) return { advanced: true, courseDone: false };
      if (action === 'done') return { advanced: false, courseDone: true };
      // 'wait' / 'sidebar'/'next' that didn't navigate yet → gating still clearing; retry
    }
    return { advanced: false, courseDone: false };
  }

  /** Walk every module to completion (never revisiting a finished one). */
  /**
   * The portal's own record of a course for the signed-in user: enrolment status
   * (2 = completed) and completion %, from the call My Courses makes. Read in the
   * page (its session authorises it). null when it can't be read.
   */
  async enrolmentOf(courseId: string): Promise<{ status: number; pct: number } | null> {
    return this.page.evaluate(async (id: string) => {
      try {
        let userId = localStorage.getItem('userUUID') || '';
        if (!userId) {
          const pb = await fetch('/apis/proxies/v8/user/v1/passbook', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ request: { typeName: 'competency' } }),
          }).then((r) => r.json());
          userId = pb?.result?.content?.[0]?.userId || '';
        }
        if (!userId) return null;
        const r = await fetch(`/apis/proxies/v8/learner/course/v1/user/enrollment/list/${userId}`);
        if (!r.ok) return null;
        const c = ((await r.json())?.result?.courses || []).find((x: any) => (x.courseId || x.contentId) === id);
        return c ? { status: Number(c.status), pct: Number(c.completionPercentage ?? 0) } : { status: -1, pct: 0 };
      } catch { return null; }
    }, courseId).catch(() => null);
  }

  /**
   * Play a course until the PORTAL records it complete. One pass through the
   * player is not proof: a course "finished" after 1 of its modules on UAT and
   * its competency level was never credited. So after each pass the enrolment
   * record is read; below 100% the course page is re-opened (same batch, so the
   * competency flow keeps its context), Resume is pressed, and play continues —
   * up to 3 passes. Returns the number of modules handled in total.
   */
  async completeCourse(maxModules = 60, label = 'course'): Promise<number> {
    // Where we came in — the course page WITH its batch/competency query. In the
    // competency flow every level's course runs in its own batch, so a plain
    // course link would land on a different (default) batch.
    let tocUrl = /\/app\/toc\//.test(this.page.url()) ? this.page.url() : '';
    let total = 0;
    let done = new Set<string>();
    for (let pass = 1; pass <= 3; pass++) {
      if (pass > 1) {
        await this.page.goto(tocUrl).catch(() => {});
        await this.page.waitForLoadState('domcontentloaded').catch(() => {});
      }
      // On a resume pass, skip what the portal already counts: the player starts
      // from module 1 again, and re-playing finished modules wastes the pass on
      // them — the unfinished one is what needs another go.
      if (done.size) console.log(`[${label}] resuming — skipping ${done.size} module(s) the portal already counts as complete`);
      total += await this.playOnce(maxModules, label, done);
      const courseId = (this.page.url().match(/[?&]collectionId=([^&]+)/) || [])[1]
        || (tocUrl.match(/\/app\/toc\/([^/?]+)/) || [])[1] || '';
      if (!tocUrl && courseId) {
        const batch = (this.page.url().match(/[?&]batchId=([^&]+)/) || [])[1];
        tocUrl = `${new URL(this.page.url()).origin}/app/toc/${courseId}/overview?primaryCategory=Course${batch ? `&batchId=${batch}` : ''}`;
      }
      const rec = courseId ? await this.enrolmentOf(courseId) : null;
      if (!rec) { console.log(`[${label}] ⚠️  could not read the course's completion from the portal — moving on`); break; }
      if (rec.status === 2 || rec.pct >= 100) {
        console.log(`[${label}] ✔ portal records the course complete (${rec.pct}%)`);
        break;
      }
      console.log(`[${label}] ⚠️  portal shows the course at ${rec.pct}% (status ${rec.status}) after pass ${pass} — ${pass < 3 ? 'resuming to finish it' : 'still incomplete after 3 passes'}`);
      if (pass === 3 || !tocUrl) break;
      const batchId = (tocUrl.match(/[?&]batchId=([^&]+)/) || [])[1] || '';
      done = await this.completedModules(courseId, batchId);
    }
    return total;
  }

  /**
   * The modules of a course the portal counts as completed (content state 2) for
   * the signed-in user in that batch — the per-module record behind the course %.
   * Empty when it can't be read (then nothing is skipped).
   */
  async completedModules(courseId: string, batchId: string): Promise<Set<string>> {
    const ids = await this.page.evaluate(async ({ courseId: c, batchId: b }) => {
      try {
        const userId = localStorage.getItem('userUUID') || '';
        if (!userId || !b) return [];
        const r = await fetch('/apis/proxies/v8/learner/course/v1/content/state/read', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ request: { userId, courseId: c, batchId: b, contentIds: [], fields: ['progress', 'score'] } }),
        });
        if (!r.ok) return [];
        return ((await r.json())?.result?.contentList || []).filter((x: any) => Number(x.status) === 2).map((x: any) => x.contentId);
      } catch { return []; }
    }, { courseId, batchId }).catch(() => [] as string[]);
    return new Set(ids);
  }

  /**
   * One pass through the player: enter, then handle each module until the course
   * ends. `alreadyDone` modules are skipped (the player moves past them).
   * `maxModules` counts modules actually PLAYED, not skipped ones.
   */
  private async playOnce(maxModules: number, label: string, alreadyDone: Set<string> = new Set()): Promise<number> {
    const tEnter = Date.now();
    await this.startCourse();
    console.log(`[${label}] ⏱ entered player  [+${((Date.now() - tEnter) / 1000).toFixed(1)}s]  ${this.page.url()}`);
    const seen = new Set<string>(alreadyDone);
    let processed = 0;
    for (let i = 0; processed < maxModules && i < maxModules + alreadyDone.size + 10; i++) {
      const id = rid(this.page.url());
      if (!seen.has(id)) {
        const tMod = Date.now();
        const type = await this.detectType();
        const n = processed + 1;
        await test.step(`${label} — module ${n}: ${type}`, async () => {
          await this.completeByType(type);
        });
        seen.add(id);
        processed++;
        console.log(`[${label}] module ${processed}: ${type}  [+${((Date.now() - tMod) / 1000).toFixed(1)}s]`);
      }
      const { advanced, courseDone } = await this.advance(seen);
      if (courseDone) break;
      await this.page.waitForTimeout(advanced ? 2_500 : 2_000); // let the next resource load
    }
    return processed;
  }
}
