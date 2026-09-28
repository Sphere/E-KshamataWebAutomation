import { chromium } from '@playwright/test';
const BASE = 'http://localhost:3000';
const b = await chromium.launch();
const ctx = await b.newContext();
const p = await ctx.newPage();

async function dump(label) {
  await p.waitForTimeout(3500);
  console.log(`\n\n########## ${label} ##########`);
  console.log('URL:', p.url());
  const headings = await p.$$eval('h1,h2,h3,h4,ion-title,[class*="title" i]', els =>
    [...new Set(els.map(e => (e.innerText || '').trim()).filter(t => t && t.length < 90))].slice(0, 25));
  console.log('-- headings/titles:\n' + headings.join('\n'));
  const cardSel = '[class*="card" i], mat-card, ion-card, [class*="tile" i], [class*="course" i], [class*="program" i]';
  const cards = await p.$$eval(cardSel, els =>
    [...new Set(els.map(e => {
      const t = (e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 110);
      const cls = (e.className ? e.className.toString() : '').split(' ')[0].slice(0, 40);
      return t ? `[${cls}] ${t}` : null;
    }).filter(Boolean))].slice(0, 40));
  console.log(`-- cards (${cards.length}):\n` + cards.join('\n---\n'));
  const btns = await p.$$eval('button, ion-button, [role="button"], a[class*="btn" i]', els =>
    [...new Set(els.map(e => (e.innerText || '').trim() || e.getAttribute('aria-label')).filter(Boolean))].slice(0, 30));
  console.log('-- buttons/ctas: ' + btns.join(' | '));
  const inputs = await p.$$eval('input,select,textarea,ion-input,ion-select', els =>
    [...new Set(els.map(e => e.getAttribute('placeholder') || e.getAttribute('name') || e.getAttribute('type') || e.tagName).filter(Boolean))].slice(0, 20));
  if (inputs.length) console.log('-- inputs: ' + inputs.join(' | '));
}

await p.goto(`${BASE}/`, { waitUntil: 'networkidle' }).catch(() => {});
await dump('HOME');

// Capture nav hrefs
const nav = await p.$$eval('[class*="nav"] a, nav a, [class*="menu"] a, a', els =>
  els.map(e => ({ text: (e.innerText || '').trim(), href: e.getAttribute('href') }))
     .filter(x => x.text && x.href && /course|competency|account|profile|home|explore/i.test(x.text + x.href)));
console.log('\n=== NAV HREFS ===');
console.log([...new Map(nav.map(x => [x.text + x.href, x])).values()].map(x => `${x.text} -> ${x.href}`).join('\n'));

for (const [label, name] of [['MY COURSES', /my courses/i], ['COMPETENCY', /competency/i], ['ACCOUNT', /account/i]]) {
  try {
    await p.locator('a, button, ion-tab-button', { hasText: name }).first().click({ timeout: 8000 });
    await p.waitForLoadState('networkidle').catch(() => {});
    await dump(label);
  } catch (e) { console.log(`\n[${label}] could not open: ${e.message.split('\n')[0]}`); }
}

// Drill into first program card from home
try {
  await p.goto(`${BASE}/`, { waitUntil: 'networkidle' }).catch(() => {});
  await p.waitForTimeout(3000);
  await p.locator('[class*="program-card"], [class*="card"]').first().click({ timeout: 8000 });
  await p.waitForLoadState('networkidle').catch(() => {});
  await dump('PROGRAM CARD -> DETAIL');
} catch (e) { console.log(`\n[CARD DETAIL] ${e.message.split('\n')[0]}`); }

await b.close();
