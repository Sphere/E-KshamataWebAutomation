import { chromium } from '@playwright/test';
const BASE = 'http://localhost:3000';
const b = await chromium.launch();
const p = await (await b.newContext()).newPage();

async function fullText(url, label) {
  await p.goto(`${BASE}${url}`, { waitUntil: 'networkidle' }).catch(() => {});
  await p.waitForTimeout(5000);
  console.log(`\n\n########## ${label}  (${p.url()}) ##########`);
  const txt = await p.locator('body').innerText().catch(() => '');
  // Strip the persistent header/footer noise for readability
  const lines = txt.split('\n').map(s => s.trim()).filter(Boolean)
    .filter(s => !/^(brightness_6|Home|My Courses|Competency|Account|Chat with us|What do you want)/.test(s));
  console.log([...new Set(lines)].slice(0, 60).join('\n'));
}

await fullText('/app/user/competency', 'COMPETENCY DASHBOARD');
await fullText('/app/profile-view', 'ACCOUNT / PROFILE-VIEW');

// A course TOC: open My Courses, click first Resume/course
await p.goto(`${BASE}/app/user/my_courses`, { waitUntil: 'networkidle' }).catch(() => {});
await p.waitForTimeout(4000);
try {
  await p.locator('[class*="card-block"], [class*="mini-card"]').first().click({ timeout: 8000 });
  await p.waitForLoadState('networkidle').catch(() => {});
  await p.waitForTimeout(4000);
  console.log(`\n\n########## COURSE DETAIL / TOC  (${p.url()}) ##########`);
  const txt = await p.locator('body').innerText().catch(() => '');
  const lines = txt.split('\n').map(s => s.trim()).filter(Boolean)
    .filter(s => !/^(brightness_6|Home|My Courses|Competency|Account|Chat with us|What do you want)/.test(s));
  console.log([...new Set(lines)].slice(0, 50).join('\n'));
  const tabs = await p.$$eval('[class*="tab" i], mat-tab, ion-segment-button', els =>
    [...new Set(els.map(e => (e.innerText || '').trim()).filter(Boolean))].slice(0, 15));
  console.log('-- TABS: ' + tabs.join(' | '));
} catch (e) { console.log('[TOC] ' + e.message.split('\n')[0]); }

await b.close();
