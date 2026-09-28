import { test } from '@playwright/test';
import { CompetencyHomePage } from './pages/competency-home.page';
import { SelfAssessmentPage } from './pages/self-assessment.page';
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
test.setTimeout(180_000);

test('probe fail path', async ({ page }) => {
  const COMPETENCY = process.env.COMPETENCY || 'Stage 4 monitoring';
  const home = new CompetencyHomePage(page);
  const sa = new SelfAssessmentPage(page);

  await page.goto(`${BASE}/page/home`);
  await page.waitForLoadState('networkidle').catch(() => {});
  await home.waitForLoaded();
  const title = await home.startSelfAssessmentByName(COMPETENCY);
  console.log('[F] competency:', title);
  await page.waitForURL(/\/viewer\/quiz\//, { timeout: 25_000 });
  console.log('[F] quiz url:', page.url().split('?')[0]);

  // Start the quiz but submit WITHOUT answering (deliberate fail)
  await sa.startNow();
  for (let i = 0; i < 12; i++) {
    if (await sa.isResult()) break;
    const btn = page.locator('button.btn-active').first();
    if (!(await btn.isVisible().catch(() => false))) break;
    await btn.click().catch(() => {});
    await page.waitForTimeout(1800);
  }
  await page.waitForTimeout(2000);

  const res = await page.evaluate(() => ({
    buttons: Array.from(document.querySelectorAll('button')).map(b => (b.textContent||'').trim()).filter(Boolean),
    heading: (document.querySelector('h1,h2,h3')?.textContent||'').trim(),
    hasNotCleared: /not cleared/i.test(document.body.textContent||''),
    bodySnippet: (document.body.textContent||'').replace(/\s+/g,' ').match(/self assessment[^]*?(go back to home|$)/i)?.[0]?.slice(0,200),
  }));
  console.log('[F] fail-result:', JSON.stringify(res, null, 2));

  // Click "Start Learning" / "Start Course" and see where it goes
  const startCourse = page.getByRole('button', { name: /start (learning|course)/i }).first();
  console.log('[F] startCourse visible?', await startCourse.isVisible().catch(()=>false));
  await startCourse.click().catch(e => console.log('[F] click err', e.message));
  await page.waitForTimeout(6000);
  console.log('[F] after Start Course URL:', page.url());
  const after = await page.evaluate(() => ({
    heading: (document.querySelector('h1,h2,h3,.title,.course-title')?.textContent||'').trim().slice(0,80),
    buttons: Array.from(document.querySelectorAll('button')).map(b=>(b.textContent||'').trim()).filter(Boolean).slice(0,10),
  }));
  console.log('[F] after Start Course DOM:', JSON.stringify(after));
});
