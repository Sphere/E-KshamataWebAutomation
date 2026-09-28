/**
 * Course certificate — generate and download it from the course TOC.
 * ──────────────────────────────────────────────────────────────────
 * A certificate only exists once the portal has recorded the course as 100%
 * complete, and generation is ASYNCHRONOUS: the first click after finishing a
 * course usually answers "your certificate is being generated" rather than
 * handing one over — and on staging the TOC needed minutes to show either the
 * 100% or the Certificate action at all. So this retries, re-opening the TOC
 * each time: CERTIFICATE_ATTEMPTS (5) rounds, CERTIFICATE_WAIT_SEC (30) apart.
 *
 * The control is a `div.toc-icon-action` ("Certificate" + a download icon) on
 * the overview — NOT a <button> — and clicking it opens a preview dialog that
 * paints the certificate onto a <canvas> before its Download button works.
 * Both English and Hindi wordings are matched: the portal is Hindi for most
 * orgs, and an English-only regex silently finds nothing there.
 *
 * Ported from the Sphere suite (tests/CourseComplete.spec.ts) — the two
 * portals run the same Angular app, so the selectors carry over.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, type Download, type Page } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'https://ekshamata.aastrika.org';

/**
 * The reason returned when the course itself offers no certificate — most
 * Ekshamata courses do not. A caller can tell this apart from a certificate
 * that merely has not been generated yet, which is worth retrying.
 */
export const NOT_OFFERED = 'the course does not issue a certificate';

/**
 * Does this course issue a certificate at all?
 *
 * `issueCertification` on the course metadata is the portal's own flag and is
 * readable without a token. Checking it first turns the commonest outcome from
 * three fruitless clicks plus 40s of waiting into one honest sentence.
 * Returns null when the read fails — unknown, so the click is still attempted.
 */
export async function issuesCertificate(origin: string, courseId: string): Promise<boolean | null> {
  try {
    const res = await fetch(`${origin}/api/content/v1/read/${courseId}?fields=name,issueCertification`);
    if (!res.ok) return null;
    const body: any = await res.json();
    const flag = body?.result?.content?.issueCertification;
    return typeof flag === 'boolean' ? flag : null;
  } catch {
    return null;
  }
}

/** Where certificates are written. */
export const CERT_DIR = resolve(process.cwd(), 'test-reports', 'certificates');

export interface CertificateResult {
  /** Absolute path of the saved file, or null when nothing was downloaded. */
  file: string | null;
  /** Why — 'downloaded', 'incomplete (42%)', 'still generating', 'not generated yet'. */
  reason: string;
}

/** "Care of Newborn & Resuscitation" → "Care_of_Newborn_Resuscitation". */
function slug(courseName: string): string {
  return courseName.replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'course';
}

/** Saves a download as test-reports/certificates/Certificate_<course>.<ext>. */
async function save(dl: Download, courseName: string): Promise<string> {
  // The portal serves certificates as PDF or as an image; jfif/jpeg are the
  // same thing under two names, so they are normalised to one extension.
  let ext = (dl.suggestedFilename().split('.').pop() || 'pdf').toLowerCase();
  if (ext === 'jfif' || ext === 'jpeg') ext = 'jpg';
  if (!existsSync(CERT_DIR)) mkdirSync(CERT_DIR, { recursive: true });
  const dest = resolve(CERT_DIR, `Certificate_${slug(courseName)}.${ext}`);
  await dl.saveAs(dest);
  // Attached as well, so the certificate travels with the run's report.
  await test.info().attach(`certificate-${slug(courseName)}`, { path: dest }).catch(() => {});
  return dest;
}

/** The course progress the TOC shows, or null when it shows no figure. */
async function tocProgress(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const text = (document.body as HTMLElement).innerText || '';
    const pct = text.match(/(\d{1,3})\s*%/);
    return pct ? Number(pct[1]) : null;
  });
}

/**
 * Downloads the certificate for a completed course.
 *
 * Returns rather than throws: a course can be legitimately complete with the
 * certificate still generating, and the caller decides whether that is a
 * failure. `attempts` re-opens the TOC from scratch each round.
 */
export async function downloadCertificate(
  page: Page,
  opts: { courseId: string; courseName: string; attempts?: number },
): Promise<CertificateResult> {
  const { courseId, courseName } = opts;
  const attempts = opts.attempts ?? Number(process.env.CERTIFICATE_ATTEMPTS || 5);
  // How long to wait before re-opening the TOC. Measured, not guessed: a
  // course finished on staging showed neither progress nor a Certificate
  // action immediately afterwards, and both were there minutes later.
  const waitMs = Number(process.env.CERTIFICATE_WAIT_SEC || 30) * 1000;
  const toc = `${BASE}/app/toc/${courseId}/overview`;
  let reason = 'no control';

  // Ask the course before asking the DOM.
  if ((await issuesCertificate(new URL(BASE).origin, courseId)) === false) {
    console.log(`[cert] "${courseName}" is not a certificate-issuing course — nothing to download`);
    return { file: null, reason: NOT_OFFERED };
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    console.log(`[cert] attempt ${attempt}/${attempts} — opening ${toc}`);
    await page.goto(toc).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(3_000);

    // Below 100% there is nothing to download and retrying cannot help.
    const progress = await tocProgress(page);
    if (progress !== null && progress < 100) {
      console.log(`[cert] the overview reports ${progress}% — no certificate until it reaches 100%`);
      return { file: null, reason: `incomplete (${progress}%)` };
    }

    // Three shapes, most specific first: the TOC action div, a real button,
    // then the bare label.
    const certBtn = page
      .locator('.toc-icon-action, [class*="toc-icon-action"]').filter({ hasText: /certificate|प्रमाणपत्र|प्रमाण पत्र/i })
      .or(page.getByRole('button', { name: /certificate|प्रमाणपत्र|प्रमाण पत्र/i }))
      .or(page.getByText(/^(certificate|प्रमाणपत्र|प्रमाण पत्र)$/i))
      .first();

    if (!(await certBtn.isVisible({ timeout: 8_000 }).catch(() => false))) {
      // The portal has not finished generating it (or has not caught up with
      // the completion yet). Both resolve on their own — wait and look again.
      console.log(`[cert] no certificate control yet — waiting ${waitMs / 1000}s, then re-opening`);
      reason = 'not generated yet';
      if (attempt < attempts) await page.waitForTimeout(waitMs);
      continue;
    }

    await certBtn.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});

    // Clicking either downloads straight away or opens the preview dialog, so
    // the download listener has to be armed BEFORE the click, not after.
    const [direct] = await Promise.all([
      page.waitForEvent('download', { timeout: 5_000 }).catch(() => null),
      certBtn.click({ timeout: 5_000 }).catch(() => {}),
    ]);
    if (direct) return { file: await save(direct, courseName), reason: 'downloaded' };

    await page.waitForTimeout(2_000);

    const dlBtn = page
      .locator('button.download-btn, .mat-mdc-dialog-panel .download-btn, [role="dialog"] [class*="download"]')
      .or(page.getByRole('button', { name: /download|डाउनलोड/i }))
      .first();

    if (await dlBtn.isVisible({ timeout: 10_000 }).catch(() => false)) {
      // The dialog paints the certificate onto a canvas first; clicking
      // Download before that finishes produces no file at all.
      await page.locator('.mat-mdc-dialog-panel canvas, [role="dialog"] canvas')
        .first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(2_500);

      for (let click = 1; click <= 2; click++) {
        const [dl] = await Promise.all([
          // 25s: generating and streaming the file is genuinely slow.
          page.waitForEvent('download', { timeout: 25_000 }).catch(() => null),
          dlBtn.click({ timeout: 4_000 }).catch(() => {}),
        ]);
        if (dl) return { file: await save(dl, courseName), reason: 'downloaded' };
        console.log(`[cert] download not captured (${click}/2) — clicking again`);
        await page.waitForTimeout(2_000);
      }
    }

    // "Your certificate is being generated" — the expected answer right after
    // finishing a course. Wait it out and re-open the TOC.
    const generating = page
      .getByText(/taking (some )?time|is being generated|will be (generated|ready)|being processed|try again later|जनरेट|तैयार किया जा रहा/i)
      .first();
    if (await generating.isVisible({ timeout: 2_000 }).catch(() => false)) {
      const msg = ((await generating.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim().slice(0, 70);
      console.log(`[cert] still generating ("${msg}") — waiting ${waitMs / 1000}s, then re-opening`);
      reason = 'still generating';
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(waitMs);
      continue;
    }

    console.log('[cert] clicked the certificate, but no download and no message appeared');
    reason = 'no download';
    await page.waitForTimeout(8_000);
  }

  return { file: null, reason };
}
