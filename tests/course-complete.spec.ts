/**
 * Complete an ENTIRE course, end to end — on any environment.
 * ──────────────────────────────────────────────────────────
 * Give a course NAME (or its do_id) and this opens it and finishes every
 * module — PDFs, videos, content pages and in-course assessments — using the
 * shared CoursePlayer (the same one the competency runner drives). Assessments
 * are answered from the real, token-free answer key.
 *
 * The name is resolved to a do_id against the LIVE catalogue of whichever
 * environment BASE_URL points at, so the same command works on production and
 * on staging — the two hold different course sets.
 *
 *   npm run run:course                 pick environment + course + account (prompts)
 *   npm run run:course:prod            production, $env:COURSE_NAME
 *   npm run run:course:stage           staging, $env:COURSE_NAME
 *
 *   $env:COURSE_NAME="Administration of drugs through IV"; npm run run:course:prod
 *
 * Inputs (all optional except the course):
 *   COURSE_NAME   course title; matched exactly first, then as a substring
 *   COURSE_ID     do_… identifier, skips the name lookup entirely
 *   COURSE_EMAIL / COURSE_PASSWORD   the learner to run as
 *                 → else EKSHAMATA_EMAIL / EKSHAMATA_PASSWORD from .env
 *                 → else a user for $env:ORG (REUSE_USERS=1 reuses the newest)
 *   MAX_MODULES   safety ceiling on the module count (default 60)
 *   CERTIFICATE   0 skips the certificate download at the end (default: on)
 *
 * The certificate lands in test-reports/certificates/. To fetch one for a
 * course that is ALREADY complete, skip the walk entirely:
 *   npm run run:certificate
 */
import { test, expect, type Page } from '@playwright/test';
import { CoursePlayer, type ModuleType } from './pages/course-player.page';
import { loginWithPassword, BASE_URL } from './helpers/login';
import { captureApiHeaders } from './helpers/real-answer-key';
import { getUserFor } from './helpers/user-lookup';
import { resolveCourse } from './helpers/course-catalogue';
import { downloadCertificate, NOT_OFFERED } from './helpers/certificate';

const COURSE_NAME = (process.env.COURSE_NAME || '').trim();
const COURSE_ID = (process.env.COURSE_ID || '').trim();
const MAX_MODULES = Number(process.env.MAX_MODULES || 60);
const ORG = (process.env.ORG || 'BNRC').toUpperCase();
/** Download the certificate once the course is complete (CERTIFICATE=0 to skip). */
const CERTIFICATE = process.env.CERTIFICATE !== '0';

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The course's leaf resources — what "the entire course" actually means. Used
 * to know when the run is finished rather than trusting the player to say so.
 */
type Leaf = { id: string; name: string; mimeType: string };

async function courseLeaves(origin: string, id: string): Promise<Leaf[]> {
  const res = await fetch(`${origin}/api/course/v1/hierarchy/${id}`);
  if (!res.ok) return [];
  const body: any = await res.json();
  const root = body?.result?.content ?? body?.result?.course;
  if (!root) return [];
  const out: Leaf[] = [];
  (function walk(node: any) {
    for (const child of node.children ?? []) {
      if (child.children?.length) walk(child);
      else out.push({ id: child.identifier, name: child.name, mimeType: child.mimeType || '' });
    }
  })(root);
  return out;
}

/** Which player route serves a resource of this mime type. */
function viewerFor(mimeType: string): string {
  if (/^video\//i.test(mimeType) || /youtube/i.test(mimeType)) return 'video';
  if (/pdf/i.test(mimeType)) return 'pdf';
  if (/json/i.test(mimeType)) return 'quiz'; // questionsets are served as JSON
  if (/html/i.test(mimeType)) return 'html';
  return 'content';
}

/**
 * How to consume a resource, from its mime type in the hierarchy.
 *
 * This beats sniffing the rendered page: the player's own detection reads a
 * `<video>` element before it reads the URL, so an assessment that ships with
 * one is treated as a video — it then "plays" for three minutes and is never
 * answered, leaving the course short of 100%. The hierarchy is authoritative.
 * Returns null for a mime type we do not recognise, and the page is sniffed then.
 */
function moduleTypeFor(mimeType: string): ModuleType | null {
  const viewer = viewerFor(mimeType);
  if (viewer === 'video') return 'video';
  if (viewer === 'pdf') return 'pdf';
  if (viewer === 'quiz') return 'assessment';
  if (viewer === 'html') return 'content';
  return null;
}

/**
 * The module links the player itself renders, by resource id. Their hrefs carry
 * the right viewer route and query for this course, so they beat anything built
 * from the mime type — locked modules are included, since we navigate directly
 * rather than clicking them.
 */
async function playerModuleLinks(page: Page): Promise<Map<string, string>> {
  const pairs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href*="/viewer/"]'))
      .map((a) => {
        const href = (a as HTMLAnchorElement).getAttribute('href') || '';
        const id = (href.match(/(do_\w+)/) || [])[1] || '';
        return [id, href] as [string, string];
      })
      .filter(([id]) => Boolean(id)),
  );
  return new Map(pairs);
}

/**
 * Tell the app the resource is finished. Consuming a resource enables the
 * player-nav "Next"; clicking it is what posts the progress, so a run that
 * navigates away without clicking can leave a module at 0%.
 */
async function registerCompletion(page: Page): Promise<void> {
  await page.evaluate(() => {
    const nav = document.querySelector('app-player-navigation-widget') as HTMLElement | null;
    const scope: ParentNode = nav || document;
    const next = Array.from(scope.querySelectorAll('button')).find(
      (b) => /^(next|अगला)$/i.test((b.textContent || '').trim())
        && !(b as HTMLButtonElement).disabled
        && (b as HTMLElement).offsetParent !== null,
    );
    if (next) (next as HTMLElement).click();
  }).catch(() => {});
  await page.waitForTimeout(2_500);
}

/** The learner this run signs in as. */
async function account(): Promise<{ email: string; password: string; source: string }> {
  if (process.env.COURSE_EMAIL && process.env.COURSE_PASSWORD) {
    return { email: process.env.COURSE_EMAIL, password: process.env.COURSE_PASSWORD, source: 'COURSE_EMAIL' };
  }
  if (process.env.EKSHAMATA_EMAIL && process.env.EKSHAMATA_PASSWORD) {
    return { email: process.env.EKSHAMATA_EMAIL, password: process.env.EKSHAMATA_PASSWORD, source: 'EKSHAMATA_EMAIL' };
  }
  // Nothing given: a user for the org. Staging cannot provision (its backend
  // rejects API-created logins), so this path is really a production one.
  const user = await getUserFor(ORG, (process.env.CREATE_DESIGNATION || '').trim());
  return { email: user.email, password: user.password, source: `${ORG} user` };
}

/**
 * What the course overview says about progress once the run is done. Returns a
 * percentage when the page shows one, else null — the TOC renders progress
 * differently per build, so a missing number is not treated as a failure.
 */
async function progressPercent(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const text = (document.body as HTMLElement).innerText || '';
    const pct = text.match(/(\d{1,3})\s*%/);
    if (pct) return Number(pct[1]);
    if (/\b(completed|पूर्ण|पूरा)\b/i.test(text)) return 100;
    return null;
  });
}

/**
 * What the PORTAL already records as finished for this course, per module.
 *
 * Re-running a course that is nearly done should not sit through every video
 * again just to reach the one module that failed. The portal's enrolment record
 * carries a per-content status (2 = completed), so those modules are skipped
 * and the run goes straight to what is left.
 *
 * The user id comes off the app's OWN enrolment request rather than being
 * guessed at — the portal fires it on the home page, and its path ends in the
 * id. Returns an empty set when anything is unavailable, so a failure here
 * costs a slow run, never a wrong one.
 */
async function completedModules(page: Page, courseId: string): Promise<Set<string>> {
  const done = new Set<string>();
  try {
    let uid = '';
    page.on('request', (r) => {
      const m = r.url().match(/enrollment\/list\/([0-9a-f-]{36})/i);
      if (m && !uid) uid = m[1];
    });
    await page.goto(`${BASE_URL}/page/home`);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2_500);
    if (!uid) return done;

    const body = await page.evaluate(async (id: string) => {
      const url = `/apis/proxies/v8/learner/course/v1/user/enrollment/list/${id}`
        + '?fields=name,identifier&batchDetails=name,status';
      const res = await fetch(url);
      return res.ok ? await res.json() : null;
    }, uid);

    const courses = body?.result?.courses ?? [];
    const hit = courses.find((c: any) => c?.courseId === courseId);
    for (const [contentId, status] of Object.entries(hit?.contentStatus ?? {})) {
      if (Number(status) === 2) done.add(contentId);
    }
  } catch {
    /* fall through — an empty set just means "walk everything" */
  }
  return done;
}

test.describe('Course completion', () => {
  // A full course — several videos, PDFs and an assessment — runs long.
  test.setTimeout(Number(process.env.COURSE_TIMEOUT_MIN || 90) * 60 * 1000);

  test(`completes "${COURSE_NAME || COURSE_ID || '(none given)'}"`, async ({ page }) => {
    expect(
      COURSE_NAME || COURSE_ID,
      'Name the course: $env:COURSE_NAME="…" (or COURSE_ID=do_…), or run: npm run run:course',
    ).toBeTruthy();

    const origin = new URL(BASE_URL).origin;
    const env = new URL(BASE_URL).hostname;

    const course = await test.step('Find the course on this environment',
      () => resolveCourse(origin, { name: COURSE_NAME, id: COURSE_ID }));
    console.log(`[course] ${env} → "${course.name}" [${course.identifier}]`);

    // Hook the API headers BEFORE navigating — the in-course answer key is
    // fetched with the credentials of the first authenticated call we see.
    captureApiHeaders(page);

    const who = await account();
    await test.step(`Log in as ${who.email} (${who.source})`, () => loginWithPassword(page, who.email, who.password));

    const leaves = (await courseLeaves(origin, course.identifier)).slice(0, MAX_MODULES);
    expect(leaves.length, `could not read the modules of "${course.name}" from the hierarchy`).toBeGreaterThan(0);
    console.log(`[course] ${leaves.length} module(s) to complete:`);
    leaves.forEach((l, i) => console.log(`         ${i + 1}. ${l.name}  [${l.mimeType}]`));

    // Skip what the portal already counts as done (REDO_ALL=1 walks everything).
    const alreadyDone = process.env.REDO_ALL === '1'
      ? new Set<string>()
      : await completedModules(page, course.identifier);
    if (alreadyDone.size) {
      const skipping = leaves.filter((l) => alreadyDone.has(l.id)).length;
      console.log(`[course] ${skipping} module(s) already complete on the portal — going straight to the rest`);
    }

    const player = new CoursePlayer(page);
    const toc = `${BASE_URL}/app/toc/${course.identifier}/overview`;

    // Enter once through the overview: that enrols the learner (the player URL
    // carries the batchId) and renders the module list we navigate by.
    await test.step('Open the course', async () => {
      await page.goto(toc);
      await page.waitForLoadState('networkidle').catch(() => {});
      await player.startCourse();
    });
    const batchId = (page.url().match(/[?&]batchId=([^&]+)/) || [])[1] || '';
    const links = await playerModuleLinks(page);
    console.log(`[course] in the player${batchId ? ` (batch ${batchId})` : ''}, ${links.size} module link(s) on screen`);

    /**
     * Walk the modules by navigating to each one directly.
     *
     * Stepping with the player's own "Next" cannot finish a course reliably:
     * a module that is merely still LOCKED looks exactly like "no modules left",
     * so a slow-to-clear video ends the walk early and the assessment behind it
     * is never opened. Going straight to each resource removes that ambiguity —
     * the gating only decides whether progress is recorded, not whether we get
     * there. A second sweep picks up anything the first left unfinished.
     */
    const done = new Set<string>();
    for (let sweep = 1; sweep <= Number(process.env.COURSE_SWEEPS || 2); sweep++) {
      for (const [i, leaf] of leaves.entries()) {
        if (done.has(leaf.id)) continue;
        // Already recorded by the portal: nothing to gain from replaying it.
        if (alreadyDone.has(leaf.id)) { done.add(leaf.id); continue; }
        const href = links.get(leaf.id)
          ?? `/viewer/${viewerFor(leaf.mimeType)}/${leaf.id}`
            + `?primaryCategory=Learning%20Resource&collectionId=${course.identifier}`
            + `&collectionType=Course${batchId ? `&batchId=${batchId}` : ''}`;

        await test.step(`Module ${i + 1}/${leaves.length}: ${leaf.name}`, async () => {
          const started = Date.now();
          await page.goto(new URL(href, BASE_URL).href);
          await page.waitForLoadState('networkidle').catch(() => {});
          const type = moduleTypeFor(leaf.mimeType) ?? (await player.detectType());
          await player.completeByType(type);
          await registerCompletion(page);
          done.add(leaf.id);
          console.log(`[course] ${i + 1}/${leaves.length} ${type.padEnd(10)} ${leaf.name}  [+${((Date.now() - started) / 1000).toFixed(1)}s]`);
        });
      }
      if (done.size >= leaves.length) break;
      console.log(`[course] sweep ${sweep}: ${done.size}/${leaves.length} done — sweeping again`);
    }

    const modules = done.size;
    console.log(`[course] completed ${modules}/${leaves.length} module(s) of "${course.name}"`);

    const percent = await test.step('Read the course progress', async () => {
      await page.goto(toc);
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(2_500);
      return progressPercent(page);
    });

    // Two separate things, asserted separately: that every module was opened and
    // consumed, and that the portal RECORDED it. Visiting a resource is not proof
    // its progress was posted, so the overview percentage is the real gate.
    expect(modules, `only ${modules} of ${leaves.length} module(s) of "${course.name}" were completed on ${env}`)
      .toBe(leaves.length);

    if (percent === null) {
      console.log(`[course] ⚠️ the overview shows no progress figure — all ${modules} module(s) were consumed, but completion could not be confirmed`);
    } else {
      console.log(`[course] overview reports ${percent}%`);
      expect(percent, `all ${modules} module(s) were consumed but "${course.name}" sits at ${percent}% on ${env} — the portal did not record it as complete`)
        .toBe(100);
    }

    // ── the certificate ────────────────────────────────────────────
    // Finishing a course is only half of what a learner is promised; the
    // certificate is the other half, so it is part of this run by default.
    // CERTIFICATE=0 skips it (a re-run that only needs the progress checked).
    if (CERTIFICATE) {
      await test.step('Download the certificate', async () => {
        const cert = await downloadCertificate(page, {
          courseId: course.identifier,
          courseName: course.name,
        });
        if (cert.file) {
          console.log(`[course] 🏅 certificate saved → ${cert.file}`);
          return;
        }
        // Most courses on this portal issue no certificate at all. That is a
        // property of the course, not a fault in the run, so it is reported
        // and the completion still counts as a pass.
        if (cert.reason === NOT_OFFERED) {
          console.log(`[course] ℹ️ "${course.name}" issues no certificate — completion verified, nothing to download`);
          return;
        }
        // Anything else means the course DOES promise a certificate and the
        // learner did not get one.
        expect(
          cert.file,
          `"${course.name}" completed on ${env}, but no certificate could be downloaded (${cert.reason}).`
            + ' Generation is asynchronous — if it was still coming, fetch it on its own with:'
            + ` npm run run:certificate:only -- --course "${course.name}"`,
        ).toBeTruthy();
      });
    }
  });
});
