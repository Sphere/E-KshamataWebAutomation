import { chromium } from '@playwright/test';
const BASE = 'http://localhost:3000';
const b = await chromium.launch();
const p = await (await b.newContext()).newPage();
await p.goto(`${BASE}/`, { waitUntil: 'networkidle' }).catch(() => {});
await p.waitForTimeout(5000);
console.log('URL:', p.url());
console.log('TITLE:', await p.title());

const headings = await p.$$eval('h1,h2,h3,h4', els =>
  els.map(e => `${e.tagName}: ${e.innerText.trim()}`).filter(t => t.length < 120 && t.split(':')[1].trim()));
console.log('\n=== HEADINGS ===');
console.log([...new Set(headings)].join('\n'));

const navs = await p.$$eval('nav a, [class*="nav"] a, [class*="menu"] a, ion-tab-button, [class*="sidebar"] a', els =>
  els.map(e => (e.innerText || '').trim() || e.getAttribute('aria-label') || e.getAttribute('href')).filter(Boolean));
console.log('\n=== NAV/MENU ===');
console.log([...new Set(navs)].slice(0, 40).join('\n'));

const cardSel = '[class*="card" i], mat-card, ion-card, [class*="tile" i], [class*="widget" i]';
const cards = await p.$$eval(cardSel, els => els.map(e => {
  const t = (e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const cls = (e.className ? e.className.toString() : '').slice(0, 60);
  return t ? `[${cls}] ${t}` : null;
}).filter(Boolean));
console.log('\n=== CARDS (' + cards.length + ') ===');
console.log([...new Set(cards)].slice(0, 60).join('\n---\n'));

const btns = await p.$$eval('button, [role="button"], ion-button', els =>
  els.map(e => (e.innerText || '').trim() || e.getAttribute('aria-label')).filter(Boolean));
console.log('\n=== BUTTONS ===');
console.log([...new Set(btns)].slice(0, 40).join(' | '));

await b.close();
