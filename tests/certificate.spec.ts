/**
 * Download the certificate of an ALREADY-COMPLETED course.
 * ────────────────────────────────────────────────────────
 * The last step of course-complete.spec.ts on its own, for when the course is
 * finished and only the certificate is wanted — a certificate that was still
 * generating when the course run ended, or one for a course completed by hand.
 *
 *   npm run run:certificate                        pick environment + course + account
 *   npm run run:certificate:prod                   production, $env:COURSE_NAME
 *   npm run run:certificate:stage                  staging, $env:COURSE_NAME
 *
 *   $env:COURSE_NAME="Care of Sick Newborn"; npm run run:certificate:prod
 *
 * Inputs are the same as the course runner:
 *   COURSE_NAME   course title; matched exactly first, then as a substring
 *   COURSE_ID     do_… identifier, skips the name lookup entirely
 *   COURSE_EMAIL / COURSE_PASSWORD   the learner to run as
 *                 → else EKSHAMATA_EMAIL / EKSHAMATA_PASSWORD from .env
 *                 → else a user for $env:ORG (REUSE_USERS=1 reuses the newest)
 *   CERTIFICATE_ATTEMPTS   how many times to re-open the TOC (default 3)
 *
 * The file lands in test-reports/certificates/Certificate_<course>.<ext>.
 */
import { test, expect } from '@playwright/test';
import { loginWithPassword, BASE_URL } from './helpers/login';
import { resolveCourse } from './helpers/course-catalogue';
import { downloadCertificate, NOT_OFFERED } from './helpers/certificate';
import { getUserFor } from './helpers/user-lookup';

const COURSE_NAME = (process.env.COURSE_NAME || '').trim();
const COURSE_ID = (process.env.COURSE_ID || '').trim();
const ORG = (process.env.ORG || 'BNRC').toUpperCase();

/** The learner this run signs in as — same precedence as the course runner. */
async function account(): Promise<{ email: string; password: string; source: string }> {
  if (process.env.COURSE_EMAIL && process.env.COURSE_PASSWORD) {
    return { email: process.env.COURSE_EMAIL, password: process.env.COURSE_PASSWORD, source: 'COURSE_EMAIL' };
  }
  if (process.env.EKSHAMATA_EMAIL && process.env.EKSHAMATA_PASSWORD) {
    return { email: process.env.EKSHAMATA_EMAIL, password: process.env.EKSHAMATA_PASSWORD, source: 'EKSHAMATA_EMAIL' };
  }
  const user = await getUserFor(ORG, (process.env.CREATE_DESIGNATION || '').trim());
  return { email: user.email, password: user.password, source: `${ORG} user` };
}

test.describe('Course certificate', () => {
  // Generation is asynchronous: the helper re-opens the TOC between attempts,
  // waiting 20s each time, so this needs more than the default timeout.
  test.setTimeout(Number(process.env.CERTIFICATE_TIMEOUT_MIN || 10) * 60 * 1000);

  test(`downloads the certificate for "${COURSE_NAME || COURSE_ID || '(none given)'}"`, async ({ page }) => {
    expect(
      COURSE_NAME || COURSE_ID,
      'Name the course: $env:COURSE_NAME="…" (or COURSE_ID=do_…), or run: npm run run:certificate',
    ).toBeTruthy();

    const origin = new URL(BASE_URL).origin;
    const env = new URL(BASE_URL).hostname;

    const course = await test.step('Find the course on this environment',
      () => resolveCourse(origin, { name: COURSE_NAME, id: COURSE_ID }));
    console.log(`[cert] ${env} → "${course.name}" [${course.identifier}]`);

    const who = await account();
    await test.step(`Log in as ${who.email} (${who.source})`,
      () => loginWithPassword(page, who.email, who.password));

    const cert = await test.step('Download the certificate', () =>
      downloadCertificate(page, { courseId: course.identifier, courseName: course.name }));

    if (cert.file) console.log(`[cert] 🏅 saved → ${cert.file}`);

    // The reason carries the distinction that matters: a course that is not
    // finished ("incomplete (60%)") differs from one whose certificate has not
    // been generated yet ("still generating"), and both differ from a course
    // that never offers one — asking for that is a mistake in the request.
    expect(
      cert.file,
      cert.reason === NOT_OFFERED
        ? `"${course.name}" issues no certificate (issueCertification=false on ${env}) — `
          + 'list the ones that do with: npm run courses:list -- --certificates'
        : `no certificate for "${course.name}" as ${who.email} on ${env} — ${cert.reason}`,
    ).toBeTruthy();
  });
});
