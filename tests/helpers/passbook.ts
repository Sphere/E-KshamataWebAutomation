/**
 * Reads the Competency Dashboard ▸ Passbook — the app's OWN record of which
 * levels an account has cleared.
 *
 * The stepper used to declare a level passed purely from the result screen it
 * saw. That is not the same thing: a run reported "Level 5 ✅ passed (70%)"
 * while the Passbook showed levels 1-4 cleared and level 5 empty, so the score
 * on screen had not been recorded. Checking the Passbook is the only way to
 * know a level actually counted.
 *
 * A cleared level chip is FILLED (green "Self" / yellow "Training"); an
 * uncleared one is transparent — that background colour is the signal.
 */
import type { Page } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'https://ekshamata.aastrika.org';

/** Open Competency ▸ Passbook (via the header nav — a direct URL redirects home). */
export async function openPassbook(page: Page): Promise<void> {
  await page.goto(`${BASE}/page/home`).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.getByRole('button', { name: /^(competency|योग्यता)$/i })
    .or(page.getByText(/^(competency|योग्यता)$/i)).first().click().catch(() => {});
  await page.waitForTimeout(3_000);
  await page.getByRole('tab', { name: /passbook|पासबुक/i }).click().catch(() => {});
  await page.waitForTimeout(3_000);
}

/**
 * The level numbers the Passbook records as CLEARED for `competency`.
 * Returns [] when the competency is not listed at all.
 */
export async function clearedLevels(page: Page, competency: string): Promise<number[]> {
  return page.evaluate((name) => {
    const panels = Array.from(document.querySelectorAll('mat-expansion-panel, .mat-expansion-panel'));
    const panel = panels.find((p) => (p.textContent || '').includes(name))
      // fall back to the whole page when the panel markup differs
      ?? document.body;
    const chips = Array.from(panel.querySelectorAll('.level')) as HTMLElement[];
    const out: number[] = [];
    for (const c of chips) {
      const n = Number((c.textContent || '').trim());
      if (!Number.isFinite(n) || n < 1) continue;
      const bg = getComputedStyle(c).backgroundColor;
      // transparent = not cleared; any filled colour = cleared
      const filled = !!bg && !/rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(bg);
      if (filled) out.push(n);
    }
    return [...new Set(out)].sort((a, b) => a - b);
  }, competency);
}
