/**
 * Every role's HOMEPAGE, environment vs environment (production, staging, UAT),
 * in one command and one sheet.
 * ──────────────────────────────────────────────────────────────────────────
 * Walks all 19 roles in src/config/orgs.ts. For each one it signs in on BOTH
 * environments — as that role's own account on each, because the two backends
 * share no accounts — opens /page/home, waits for the learning plan to render,
 * and compares the two.
 *
 *   npm run compare:orgs                 every role
 *   npm run compare:orgs -- --org MP     just that org's roles
 *   npm run compare:orgs -- --headless   do not show the browsers
 *   npm run compare:orgs -- --a prod --b uat   skip the environment question
 *   npm run compare:orgs -- --create-missing   create accounts a role lacks, without asking
 *
 * There are no option prompts: the visual threshold is 0.5%, the browsers are
 * visible, every login is fresh, and the report opens at the end. Pass
 * --threshold / --headless / --no-open to change any of that.
 *
 * Output — ONE report covering every role:
 *   compare-reports/homepage-layout_<stamp>.html   the sheet, with screenshots
 *   compare-reports/homepage-layout_<stamp>.xlsx   the same rows as a spreadsheet
 *   compare-reports/homepage-layout_<stamp>.txt    the same rows as text
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { capture } from './lib/env-capture.mjs';
import { diffRoute, pixelDiff } from './lib/env-diff.mjs';
import { authState, createdUsersOn } from './lib/env-login.mjs';
import { writeHomepageSheet } from './lib/homepage-sheet.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);
require('dotenv').config({ path: resolve(ROOT, '.env') });

// ── options: fixed, because the answers never varied ──────────────────
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(name);

// ── which two environments ─────────────────────────────────────────────
// --a / --b take a name (prod, staging, uat) or a full URL. Without them, an
// interactive terminal is ASKED; CI (no keyboard) keeps production vs staging.
const ENVIRONMENTS = [
  ['Production', 'https://ekshamata.aastrika.org'],
  ['Staging', 'https://ekshamata-staging.aastrika.org'],
  ['UAT', 'https://ekshamata-uat.aastrika.org'],
];
function resolveEnv(v) {
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v.replace(/\/+$/, '');
  if (/^\d+$/.test(v)) return (ENVIRONMENTS[Number(v) - 1] || [])[1] || '';
  const s = v.toLowerCase().replace(/^prod$/, 'production');
  return (ENVIRONMENTS.find(([n]) => n.toLowerCase().startsWith(s)) || [])[1] || '';
}
// ONE readline, read as a QUEUE of lines: rl.question() drops a line that arrives
// before it is asked, so two answers pasted (or piped) together lost the second.
let rl = null;
let lines = null;
async function askEnv(side, dflt) {
  if (!rl) {
    rl = (await import('node:readline')).createInterface({ input: process.stdin, terminal: false });
    lines = rl[Symbol.asyncIterator]();
  }
  process.stdout.write(`   ${side} (Enter = ${dflt}) : `);
  const { value } = await lines.next();
  const answer = String(value ?? '').trim();
  const url = resolveEnv(answer || dflt);
  if (!url) { console.error(`   ✖ "${answer}" is not one of the environments (or a full https URL)`); process.exit(1); }
  return url;
}
const interactive = process.stdin.isTTY && !process.env.CI;
let URL_A = resolveEnv(flag('--a', ''));
let URL_B = resolveEnv(flag('--b', ''));
if ((flag('--a', '') && !URL_A) || (flag('--b', '') && !URL_B)) {
  console.error(`✖ Unknown environment in --a/--b. Use prod, staging, uat, or a full URL.`); process.exit(1);
}
if ((!URL_A || !URL_B) && interactive) {
  console.log('\n🌐 Compare which two environments?\n');
  ENVIRONMENTS.forEach(([n, u], i) => console.log(`   ${i + 1}. ${n.padEnd(11)} ${u}`));
  console.log('      (a number, a name, or a full https URL)\n');
  if (!URL_A) URL_A = await askEnv('A — baseline        ', 'Production');
  if (!URL_B) URL_B = await askEnv('B — the one to check', 'Staging');
  rl?.close();
}
URL_A ||= ENVIRONMENTS[0][1];
URL_B ||= ENVIRONMENTS[1][1];
// Labels follow the chosen environments (Production / Staging / UAT).
const labelOf = (u) => (ENVIRONMENTS.find(([, x]) => x === u) || [new URL(u).hostname])[0];
const LABEL_A = labelOf(URL_A);
const LABEL_B = labelOf(URL_B);
const THRESHOLD = Number(flag('--threshold', '0.5'));
const HEADED = !has('--headless');
const OPEN = !has('--no-open');
const ONLY_ORG = (flag('--org', '') || '').toUpperCase();
// The homepage lazy-renders its competency cards, so it needs longer than a
// plain route: wait for the plan to appear, then let it settle.
const SETTLE = Number(flag('--settle', '2500'));
const PLAN_TIMEOUT = Number(flag('--plan-timeout', '30000'));

/** Every org + designation in the registry, in registry order. */
function allRoles() {
  const src = readFileSync(resolve(ROOT, 'src/config/orgs.ts'), 'utf-8');
  const roles = [];
  const re = /key:\s*'([^']+)'[\s\S]*?designations:\s*\[([\s\S]*?)\]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    for (const d of m[2].matchAll(/designation:\s*'([^']+)'/g)) {
      roles.push({ org: m[1], designation: d[1] });
    }
  }
  return roles;
}

/**
 * Accounts for this exact org + role on one environment, newest first.
 *
 * Several, not one: a batch of accounts created on 2026-09-08 never had their
 * password registered (the same backend fault that hit staging), so the NEWEST
 * account for a role is often the one that cannot log in. Falling through to the
 * next one keeps a role comparable instead of reporting it as blocked.
 */
function accountsFor(baseUrl, org, designation, limit = 5) {
  return createdUsersOn(baseUrl)
    .filter((u) => u.orgKey === org && u.designation === designation)
    .slice(0, limit);
}

const roles = allRoles().filter((r) => !ONLY_ORG || r.org === ONLY_ORG);
if (!roles.length) {
  console.error(`\n✖ No roles matched --org ${ONLY_ORG}.\n`);
  process.exit(1);
}

// ── roles with no account on a chosen environment ──────────────────────
// Each backend has its own accounts. A newer environment (UAT) starts with few,
// and a role with no account can only be reported as blocked — so offer to
// create the missing ones first (tests/create-env-user.spec.ts, one per role).
// --create-missing does it without asking; CI never asks and never creates.
const missing = [];
for (const [url, label] of [[URL_A, LABEL_A], [URL_B, LABEL_B]]) {
  for (const r of roles) if (!accountsFor(url, r.org, r.designation).length) missing.push({ url, label, ...r });
}
if (missing.length) {
  console.log(`\n👤 ${missing.length} role(s) have no account yet:`);
  for (const m of missing) console.log(`   ${m.label.padEnd(11)} ${m.org} / ${m.designation}`);
  let create = has('--create-missing');
  if (!create && process.stdin.isTTY && !process.env.CI) {
    const rl = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout });
    const a = await new Promise((res) => rl.question(`   Create them now? (~20s each)  [Y/n] : `, (x) => { rl.close(); res(x.trim()); }));
    create = !/^n/i.test(a);
  }
  if (create) {
    const { spawnSync } = await import('node:child_process');
    const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
    for (const m of missing) {
      process.stdout.write(`   creating ${m.label} ${m.org} / ${m.designation} … `);
      const r = spawnSync(process.execPath, [cli, 'test', 'tests/create-env-user.spec.ts', '--project=Chrome', '--reporter=line'], {
        cwd: ROOT, encoding: 'utf-8',
        env: { ...process.env, BASE_URL: m.url, CREATE_ORG: m.org, CREATE_DESIGNATION: m.designation, CI: 'true', PW_TEST_HTML_REPORT_OPEN: 'never' },
      });
      const made = (r.stdout.match(/\[create\] ✅ (\S+@\S+)/) || [])[1];
      console.log(made ? `✅ ${made}` : '❌ failed (that role will show as blocked)');
    }
  } else {
    console.log('   Skipped — those roles will show as blocked. (--create-missing creates them.)');
  }
}

const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT_DIR = resolve(ROOT, 'compare-reports');
const ASSETS = `homepage-layout_${stamp}_assets`;
const ASSETS_DIR = resolve(OUT_DIR, ASSETS);
mkdirSync(ASSETS_DIR, { recursive: true });

console.log(`\n🏠  Homepage layout — ${LABEL_A} vs ${LABEL_B}`);
console.log(`    A: ${URL_A}`);
console.log(`    B: ${URL_B}`);
console.log(`    ${roles.length} role(s) · visual threshold ${THRESHOLD}% · fresh login every time\n`);

const { chromium } = require('playwright-core');
const browser = await chromium.launch({
  headless: !HEADED,
  args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
});
const viewport = { width: 1280, height: 800 };

/**
 * The homepage as that role sees it, or a reason it could not be reached.
 * Signing in and capturing are separate failures and the sheet says which.
 */
async function captureHome(baseUrl, candidates, prefix, roleId) {
  if (!candidates.length) return { skipped: `no account for this role on ${new URL(baseUrl).hostname}` };

  // First account that can actually sign in wins.
  let state;
  let account;
  let lastError = '';
  for (const candidate of candidates) {
    try {
      ({ state } = await authState(browser, baseUrl, candidate.email, candidate.password, {
        refresh: true, // never a cached session: a stale one hides a broken login
        print: () => {},
      }));
      account = candidate;
      break;
    } catch (e) {
      lastError = String(e.message).split('(')[0].trim();
    }
  }
  if (!account) {
    return { skipped: `none of ${candidates.length} account(s) could sign in — ${lastError}` };
  }

  const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true, storageState: state });
  const page = await context.newPage();
  try {
    const route = {
      id: roleId,
      name: 'Homepage',
      path: '/page/home',
      auth: true,
      wait: SETTLE,
      // Wait for the learning plan itself, not just the network: the cards
      // arrive after networkidle, and photographing before they land compares
      // two empty pages and calls them identical.
      steps: [{ waitFor: '.asha-card, app-asha-learning, .line-label', timeout: PLAN_TIMEOUT }],
    };
    const cap = await capture(page, route, baseUrl, { shotDir: ASSETS_DIR, fullPage: true, settle: SETTLE, prefix });
    return { cap, account };
  } catch (e) {
    return { skipped: `homepage did not load — ${String(e.message).slice(0, 120)}` };
  } finally {
    await context.close().catch(() => {});
  }
}

const rows = [];
for (const [i, role] of roles.entries()) {
  const label = `${role.org} / ${role.designation}`;
  const roleId = `${role.org}-${role.designation}`.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  process.stdout.write(`  [${String(i + 1).padStart(2)}/${roles.length}] ${label.padEnd(34)}`);

  const accA = accountsFor(URL_A, role.org, role.designation);
  const accB = accountsFor(URL_B, role.org, role.designation);

  // One environment at a time: two visible browsers racing each other on one
  // machine makes the slower side time out and report a difference that is not
  // real.
  const A = await captureHome(URL_A, accA, `a_${roleId}`, roleId);
  const B = await captureHome(URL_B, accB, `b_${roleId}`, roleId);

  if (A.skipped || B.skipped) {
    rows.push({
      ...role, label, roleId,
      accountA: accA[0]?.email ?? '—', accountB: accB[0]?.email ?? '—',
      worst: 'blocked',
      note: A.skipped ? `${LABEL_A}: ${A.skipped}` : `${LABEL_B}: ${B.skipped}`,
      findings: [], pixel: null, shots: {},
    });
    console.log(`⚠️  ${A.skipped ? LABEL_A : LABEL_B}: ${(A.skipped || B.skipped).slice(0, 46)}`);
    continue;
  }

  let pixel = null;
  let diffImage = '';
  if (A.cap.shots?.viewport && B.cap.shots?.viewport) {
    const outName = `diff_${roleId}.png`;
    pixel = pixelDiff(
      resolve(ASSETS_DIR, A.cap.shots.viewport),
      resolve(ASSETS_DIR, B.cap.shots.viewport),
      resolve(ASSETS_DIR, outName),
      { tolerance: 24, minPercent: THRESHOLD },
    );
    if (pixel.wrote) diffImage = outName;
  }

  const r = diffRoute(
    { id: roleId, name: `Homepage — ${label}`, path: '/page/home', auth: true },
    A.cap, B.cap,
    { labelA: LABEL_A, labelB: LABEL_B, pixelThreshold: THRESHOLD, pixel },
  );

  // This sweep is about LAYOUT, so it is graded on layout. Console and network
  // errors are reported alongside but do not set the verdict: every role shows
  // the same production-only console error, and letting that drive the grade
  // buried the row that actually matters — a homepage 13% different — under
  // nineteen identical "Broken" labels.
  const NOISE = new Set(['console', 'jserror', 'network']);
  const layout = r.findings.filter((f) => !NOISE.has(f.kind));
  const noise = r.findings.filter((f) => NOISE.has(f.kind));

  const pixelsMoved = pixel && !pixel.unavailable && !pixel.sizeMismatch && pixel.percent >= THRESHOLD;
  const worst = layout.some((f) => f.severity === 'error') ? 'error'
    : layout.some((f) => f.severity === 'warn') || pixelsMoved || pixel?.sizeMismatch ? 'warn'
      : layout.length ? 'info'
        : 'same';

  rows.push({
    ...role, label, roleId,
    accountA: A.account.email, accountB: B.account.email,
    worst,
    note: '',
    findings: layout,
    noise,
    pixel,
    shots: { a: A.cap.shots?.viewport, b: B.cap.shots?.viewport, diff: diffImage },
    counts: { a: A.cap.counts, b: B.cap.counts },
  });

  const mark = { error: '❌', warn: '⚠️ ', info: 'ℹ️ ', same: '✅' }[worst] ?? '  ';
  const px = pixel && !pixel.unavailable && !pixel.sizeMismatch ? ` · ${pixel.percent.toFixed(2)}% pixels` : '';
  console.log(`${mark} ${layout.length} layout finding${layout.length === 1 ? '' : 's'}${px}${noise.length ? ` (+${noise.length} console/network)` : ''}`);
}

await browser.close().catch(() => {});

const out = await writeHomepageSheet({
  rows,
  labelA: LABEL_A, labelB: LABEL_B, urlA: URL_A, urlB: URL_B,
  assetsDir: ASSETS, outDir: OUT_DIR, stamp, startedAt,
  durationMs: Date.now() - startedAt.getTime(),
});

const blocked = rows.filter((r) => r.worst === 'blocked').length;
const broken = rows.filter((r) => r.worst === 'error').length;
const review = rows.filter((r) => r.worst === 'warn').length;
const same = rows.filter((r) => r.worst === 'same').length;

console.log(`\n${'═'.repeat(70)}`);
console.log(`  ${roles.length} role(s) — ${broken} broken · ${review} to review · ${same} identical${blocked ? ` · ${blocked} could not be compared` : ''}`);
console.log(`${'═'.repeat(70)}`);
console.log(`\n📗 Homepage layout sheet : ${out.htmlPath}`);
console.log(`📊 Same rows as a sheet  : ${out.xlsxPath ?? '(exceljs not installed — skipped)'}`);
console.log(`📄 Same rows as text     : ${out.textPath}`);
console.log(`🖼  Screenshots           : ${ASSETS_DIR}\n`);

if (OPEN && existsSync(out.htmlPath)) {
  const { spawn } = await import('node:child_process');
  const opener = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', out.htmlPath]]
    : process.platform === 'darwin' ? ['open', [out.htmlPath]] : ['xdg-open', [out.htmlPath]];
  spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref();
}

process.exit(broken ? 1 : 0);
