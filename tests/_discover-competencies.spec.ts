/**
 * Discovery helper (not a real test): provision/open the competency home for the
 * chosen ORG (honouring ENSURE_LANG) and write the ACTUAL competency titles to
 * the file named in COMP_OUT. The interactive stepper launcher runs this first
 * so it can offer you the org's real learning plan — in the right language —
 * instead of a hardcoded guess.
 *
 * Run by scripts/run-stepper.mjs; not part of a normal suite.
 */
import { test } from '@playwright/test';
import * as fs from 'fs';
import { openCompetencyHome } from './helpers/session';

test('discover competencies', async ({ page }) => {
  test.setTimeout(120_000);
  const home = await openCompetencyHome(page);

  // The home lazy-renders cards — scroll until the WHOLE plan (N) has loaded.
  const loaded = await home.loadAll();
  const titles = (await home.competencyTitles()).map((t) => t.trim()).filter(Boolean);
  console.log(`[discover] plan says (${await home.learningPlanCount().catch(() => '?')}), loaded ${loaded} cards`);
  const out = process.env.COMP_OUT;
  if (out) fs.writeFileSync(out, JSON.stringify(titles, null, 2));
  console.log(`[discover] ${titles.length} competencies for ${process.env.ORG || 'BNRC'}`);
  titles.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
});
