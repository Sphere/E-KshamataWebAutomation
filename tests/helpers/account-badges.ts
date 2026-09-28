/**
 * The BADGES a learner has earned, as the portal shows them.
 * ─────────────────────────────────────────────────────────
 * The badge is a pill under the learner's name — "🏅 9 Badges Earned" — shown
 * both on the home page ("Welcome! Aastrika") and on Account ▸ profile. It is
 * NOT the same thing as Account ▸ "My Certificates", which lists downloadable
 * course certificates and can read "No Certificates" on an account that has
 * plenty of badges. Checking the wrong one reports a healthy account as broken.
 */
import type { Page } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'https://ekshamata.aastrika.org';

/** "9 Badges Earned" · "9 बैज अर्जित" · "9 बैज" — the count is what matters. */
const BADGE_PILL = /(\d+)\s*(badges?\s*earned|badges?|बैज(?:ेस)?(?:\s*अर्जित)?)/i;
/** The My-Certificates empty state, reported separately for context. */
const NO_CERTS = /कोई\s*प्रमाण\s*पत्र\s*नहीं|no\s*certificate/i;

export interface BadgeState {
  /** Badges earned, from the pill. null when no pill is on the page at all. */
  count: number | null;
  /** The pill's exact text, for the report. */
  label: string;
  /** Whether Account ▸ My Certificates shows its empty state (separate thing). */
  noCertificates: boolean;
}

/** Read the badge pill on the Account page (falls back to the home page). */
export async function readAccountBadges(page: Page): Promise<BadgeState> {
  const scrape = async () => page.evaluate(({ pill }: { pill: string }) => {
    const re = new RegExp(pill, 'i');
    const vis = (e: Element) => (e as HTMLElement).offsetParent !== null;
    const clean = (s: string | null) => (s || '').replace(/\s+/g, ' ').trim();
    // The smallest element carrying the text is the pill itself; a bigger
    // ancestor would drag in the whole sidebar.
    const hit = Array.from(document.querySelectorAll('span, div, p, a, button, li'))
      .filter((e) => vis(e) && re.test(clean(e.textContent)))
      .sort((a, b) => clean(a.textContent).length - clean(b.textContent).length)[0];
    return hit ? clean(hit.textContent) : '';
  }, { pill: BADGE_PILL.source });

  await page.goto(`${BASE}/app/profile-view`);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(4_000);

  let label = await scrape();
  if (!label) {
    // Some builds render the pill only on the home page — look there too before
    // concluding a learner has none.
    await page.goto(`${BASE}/page/home`);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(4_000);
    label = await scrape();
  }

  const noCertificates = await page.evaluate(({ empty }: { empty: string }) =>
    new RegExp(empty, 'i').test((document.body as HTMLElement).innerText || ''),
  { empty: NO_CERTS.source }).catch(() => false);

  const m = label.match(BADGE_PILL);
  return { count: m ? Number(m[1]) : null, label, noCertificates };
}
