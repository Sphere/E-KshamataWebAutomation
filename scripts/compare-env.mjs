/**
 * Production vs Staging, side by side.
 * ────────────────────────────────────
 * Loads every feature in config/compare-routes.json on BOTH environments at
 * the same time, in two browser contexts, and reports what differs:
 *
 *   UI        screenshots left/right + a pixel diff of the viewport shot,
 *             missing headings/buttons/fields/links, broken images, copy drift
 *   Function  HTTP status, redirects, blank pages, console + uncaught JS
 *             errors, failing network requests, page-settle time, build hash
 *   Data      API parity (status/count/latency) and course-catalogue parity
 *             (which courses exist on one environment but not the other)
 *
 * Output: a branded side-by-side HTML report + a JSON summary under
 * compare-reports/. Exit code is 1 when anything BLOCKING was found, so it can
 * gate a release.
 *
 *   npm run compare                        prod vs staging, public pages
 *   npm run compare -- --auth              also the signed-in features
 *   npm run compare -- --only home,course  just routes whose id/name matches
 *   npm run compare -- --headed            watch it run
 *   npm run compare -- --a https://ekshamata.aastrika.org --b http://localhost:3000
 *   npm run compare -- --threshold 1.5     ignore visual diffs under 1.5%
 *   npm run compare -- --no-catalogue      skip the course-catalogue parity pass
 *   npm run compare -- --refresh           re-fetch the course catalogue
 *   npm run compare -- --fresh-login       always log in, never reuse a session
 *
 * Credentials for --auth, most specific first:
 *   PROD_EMAIL/PROD_PASSWORD · STAGING_EMAIL/STAGING_PASSWORD →
 *   COMPARE_EMAIL/COMPARE_PASSWORD → an account created ON THAT ENVIRONMENT
 *   (created-users.txt) → EKSHAMATA_EMAIL/PASSWORD.
 *
 * Production and staging are separate backends and share no accounts, so each
 * side signs in as its own user. Make the matched pair first — same org, same
 * role, one per environment:
 *
 *   npm run create:pair -- BNRC                  a BNRC user on each side
 *   npm run compare -- --auth --org BNRC         compare as that pair
 *   npm run compare -- --auth --user X@yopmail.com   pin one side's account
 *   npm run compare -- --users                   list the accounts, by environment
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { capture, probeApi } from './lib/env-capture.mjs';
import { diffRoute, diffApi, diffCatalogue, pixelDiff } from './lib/env-diff.mjs';
import { renderReport } from './lib/env-report.mjs';
import { renderSimpleHtml, renderText } from './lib/simple-report.mjs';
import { authState, credentialsFor, credentialCandidates, explicitCredentials, createdUsers } from './lib/env-login.mjs';
import { loadCourses } from './lib/courses.mjs';
import { walk, stepsFor, withVars } from './lib/journey.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);
require('dotenv').config({ path: resolve(ROOT, '.env') });

// ── args ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(name);

const URL_A = (flag('--a', 'https://ekshamata.aastrika.org') || '').replace(/\/+$/, '');
const URL_B = (flag('--b', 'https://ekshamata-staging.aastrika.org') || '').replace(/\/+$/, '');
const LABEL_A = flag('--label-a', labelFor(URL_A));
const LABEL_B = flag('--label-b', labelFor(URL_B));
const WITH_AUTH = has('--auth');
const HEADED = has('--headed');
const REFRESH = has('--refresh');
// A session saved by the account-creation step moments ago is reused rather
// than logging the same brand-new account in a SECOND time. Older than this and
// we log in fresh, so a stale session can never hide a login that has broken.
// --fresh-login always logs in; --reuse-session accepts any session up to 6h.
const SESSION_MAX_AGE_MS = has('--reuse-session') ? 6 * 60 * 60 * 1000 : 30 * 60 * 1000;
const FRESH_LOGIN = has('--fresh-login');
const NO_CATALOGUE = has('--no-catalogue');
const NO_FULLPAGE = has('--no-fullpage');
const ONLY = (flag('--only', '') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
// Exact ids (what the interactive picker sends) and one-off paths that are not
// in the inventory — e.g. a single course page you want to eyeball right now.
const IDS = (flag('--ids', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
// Journeys: flows walked step by step on both sides. --journey all runs them all.
const JOURNEY = (flag('--journey', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const ALLOW_WRITES = has('--allow-writes');
// Which created account signs in on each side — see scripts/lib/env-login.mjs.
// --org is the useful one: the same org on both, which is what create:pair makes.
const USER = flag('--user', '') || '';
// --user-a / --user-b pin ONE account per side. The interactive runner uses them
// to lock the comparison to the exact pair it just provisioned, so a stale
// account for the same org can never be picked up instead.
const USER_A = flag('--user-a', '') || USER;
const USER_B = flag('--user-b', '') || USER;
const ORG = flag('--org', '') || '';
const CREDS_A = { user: USER_A, org: ORG };
const CREDS_B = { user: USER_B, org: ORG };
const NO_PAGES = has('--journey-only');
const NO_PDF = has('--no-pdf');
const EXTRA = argv.reduce((acc, a, i) => (a === '--route' && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);
const THRESHOLD = Number(flag('--threshold', '0.5'));
const SETTLE = Number(flag('--settle', '800'));
/**
 * The window size both environments are opened at — FULL SCREEN by default.
 *
 * Both sides must use the SAME dimensions or the pixel diff compares images of
 * different shapes, so this is resolved once and handed to both contexts.
 * `--viewport 1280x800` pins a fixed size instead (useful for a like-for-like
 * re-run of an older report, and for CI where there is no display).
 */
function fullScreenSize() {
  const explicit = flag('--viewport', '');
  if (explicit) {
    const [w, h] = explicit.split('x').map(Number);
    return { width: w || 1280, height: h || 800, source: 'the --viewport flag' };
  }
  if (process.platform === 'win32') {
    try {
      const ps = 'Add-Type -AssemblyName System.Windows.Forms; '
        + '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; '
        + "$b.Width.ToString() + 'x' + $b.Height.ToString()";
      const out = execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`,
        { encoding: 'utf-8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const [w, h] = out.split('x').map(Number);
      if (w > 0 && h > 0) return { width: w, height: h, source: 'this screen' };
    } catch (e) { /* no display, or PowerShell unavailable — fall through */ }
  }
  // Headless CI, or a platform we cannot ask: a full-HD desktop is the sane default.
  return { width: 1920, height: 1080, source: 'the 1920x1080 default' };
}

function labelFor(url) {
  const h = new URL(url).hostname;
  if (/^ekshamata\./i.test(h)) return 'Production';
  if (/staging/i.test(h)) return 'Staging';
  if (/^localhost|^127\./.test(h)) return 'Localhost';
  return h;
}

// ── --users: what accounts exist to sign in with ──────────────────────
if (has('--users')) {
  const list = createdUsers();
  if (!list.length) {
    console.log('\nNo accounts in created-users.txt yet — run: npm run create:pair -- BNRC\n');
  } else {
    // Grouped by environment, because that is the thing that decides whether an
    // account can be used at all.
    for (const host of [new URL(URL_A).hostname, new URL(URL_B).hostname]) {
      const here = list.filter((u) => u.env === host);
      console.log(`\n${here.length} account(s) on ${host}, newest first:\n`);
      for (const u of here.slice(0, 20)) {
        console.log(`  ${u.email.padEnd(38)} ${(u.orgKey || '').padEnd(10)} ${u.designation || ''}`);
      }
      if (!here.length) console.log(`  (none — make one: npm run create:pair -- <ORG>)`);
      else if (here.length > 20) console.log(`  … and ${here.length - 20} more in created-users.txt`);
    }
    console.log('\nCompare as one org on both sides:  npm run compare -- --auth --org <ORG>');
    console.log('Pin a single account:              npm run compare -- --auth --user <email>\n');
  }
  process.exit(0);
}

// ── inventory ─────────────────────────────────────────────────────────
const inventory = JSON.parse(readFileSync(resolve(ROOT, 'config', 'compare-routes.json'), 'utf-8'));
const matches = (r) => !ONLY.length || ONLY.some((o) => r.id.toLowerCase().includes(o) || r.name.toLowerCase().includes(o));
const picked = (r) => !IDS.length || IDS.includes(r.id);
// --no-inventory: compare ONLY the --route paths given on the command line.
const routes = [
  ...(has('--no-inventory') || NO_PAGES
    ? []
    : inventory.routes.filter((r) => !r.skip && picked(r) && matches(r) && (WITH_AUTH || !r.auth))),
  // A --route path is compared as given; signed-in state follows --auth.
  ...EXTRA.map((path) => ({
    id: 'adhoc-' + slug(path).slice(0, 40),
    name: path,
    path: path.startsWith('/') ? path : '/' + path,
    auth: WITH_AUTH,
  })),
];
const apiEndpoints = (inventory.api || []).filter((e) => !e.skip);

// Known noise (analytics beacons, chat widgets…) muted via config, so the
// report stays about the portal. Nothing is muted by default.
const ignoreRe = (list) => (list || []).map((p) => new RegExp(p, 'i'));
const IGNORE_CONSOLE = ignoreRe(inventory.ignore?.console);
const IGNORE_REQUESTS = ignoreRe(inventory.ignore?.requests);
let ignoredCount = 0;

/** Drop muted console errors / failing requests from a capture, in place. */
function applyIgnores(cap) {
  const before = (cap.consoleErrors?.length || 0) + (cap.failedRequests?.length || 0);
  if (IGNORE_CONSOLE.length) {
    cap.consoleErrors = (cap.consoleErrors || []).filter((t) => !IGNORE_CONSOLE.some((re) => re.test(t)));
    cap.pageErrors = (cap.pageErrors || []).filter((t) => !IGNORE_CONSOLE.some((re) => re.test(t)));
  }
  if (IGNORE_REQUESTS.length) {
    cap.failedRequests = (cap.failedRequests || []).filter((r) => !IGNORE_REQUESTS.some((re) => re.test(r.host + r.url)));
  }
  ignoredCount += before - ((cap.consoleErrors?.length || 0) + (cap.failedRequests?.length || 0));
  return cap;
}

// ── journeys ──────────────────────────────────────────────────────────
const journeyFile = resolve(ROOT, 'config', 'compare-journeys.json');
const allJourneys = existsSync(journeyFile) ? JSON.parse(readFileSync(journeyFile, 'utf-8')).journeys || [] : [];
const wantsAll = JOURNEY.includes('all');
const journeys = allJourneys.filter(
  (j) => !j.skip && (wantsAll || JOURNEY.includes(j.id)) && (WITH_AUTH || !j.auth),
);
if (JOURNEY.length && !journeys.length) {
  console.error(`\n✖ No journey matched "${JOURNEY.join(',')}". Available: ${allJourneys.map((j) => j.id).join(', ')}`);
  console.error('  (signed-in journeys need --auth)\n');
  process.exit(1);
}

if (!routes.length && !journeys.length) {
  console.error(`\n✖ No routes to compare${ONLY.length ? ` for --only ${ONLY.join(',')}` : ''}${IDS.length ? ` for --ids ${IDS.join(',')}` : ''}.`);
  console.error('  Check config/compare-routes.json (signed-in routes need --auth), or pass --route /some/path.\n');
  process.exit(1);
}

// ── output folders ────────────────────────────────────────────────────
const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT_DIR = resolve(ROOT, 'compare-reports');
const RUN_NAME = `compare_${slug(LABEL_A)}_vs_${slug(LABEL_B)}_${stamp}`;
const ASSETS_NAME = `${RUN_NAME}_assets`;
const ASSETS_DIR = resolve(OUT_DIR, ASSETS_NAME);
mkdirSync(ASSETS_DIR, { recursive: true });

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── run ───────────────────────────────────────────────────────────────
console.log(`\n🔍  Comparing ${LABEL_A} vs ${LABEL_B}`);
console.log(`    A: ${URL_A}`);
console.log(`    B: ${URL_B}`);
console.log(`    ${routes.length} feature${routes.length === 1 ? '' : 's'}${WITH_AUTH ? ' (incl. signed-in)' : ' (public only — add --auth for the rest)'}\n`);

const { chromium } = require('playwright-core');
const screen = fullScreenSize();
const browser = await chromium.launch({
  headless: !HEADED,
  args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check',
    // Headed runs open maximized so what you watch matches what is captured.
    '--start-maximized', `--window-size=${screen.width},${screen.height}`],
});

const viewport = { width: screen.width, height: screen.height };
console.log(`    window ${viewport.width}x${viewport.height} (${screen.source}) — both environments`);
let authNote = 'public pages only';

/**
 * One context per environment, signed in when asked for.
 *
 * `candidates` are tried in order and the first that logs in wins — the newest
 * entry in created-users.txt can be an account a provisioning run is still
 * finishing, and that must not sink the whole comparison.
 *
 * @returns {Promise<{context: object, account: object|null}>}
 */
async function contextFor(baseUrl, label, candidates) {
  const opts = { viewport, ignoreHTTPSErrors: true };
  let account = null;

  if (WITH_AUTH) {
    if (!candidates.length) {
      console.log(`   ⚠️  no credentials for ${label} — signed-in features will be compared logged out`);
      if (USER || ORG) {
        console.log(`      (nothing matched ${USER ? '--user ' + USER : '--org ' + ORG} — list them with: npm run compare -- --users)`);
      }
    }
    for (const [i, creds] of candidates.entries()) {
      try {
        const { state } = await authState(browser, baseUrl, creds.email, creds.password, { refresh: FRESH_LOGIN, maxAgeMs: SESSION_MAX_AGE_MS });
        opts.storageState = state;
        account = creds;
        break;
      } catch (e) {
        console.log(`   ⚠️  login failed on ${label} as ${creds.email}: ${e.message}`);
        if (i + 1 < candidates.length) console.log(`      trying the next account: ${candidates[i + 1].email}`);
      }
    }
    if (!account && candidates.length) {
      console.log(`   ⚠️  could not sign in on ${label} — its signed-in features are compared logged out`);
      if (/staging/i.test(baseUrl)) {
        console.log('      (staging is a separate backend — accounts created on production may not exist there.');
        console.log('       Set STAGING_EMAIL/STAGING_PASSWORD in .env to sign in with a staging account.)');
      }
    }
  }
  return { context: await browser.newContext(opts), account };
}

// Each side signs in with an account created on ITS OWN backend — production
// and staging do not share accounts, so there is no one login that works on
// both. Provision the matched pair with:  npm run create:pair -- <ORG>
// Same org, same role on both sides keeps the comparison fair; --org pins it.
const candidatesA = WITH_AUTH ? credentialCandidates(URL_A, CREDS_A) : [];
const candidatesB = WITH_AUTH ? credentialCandidates(URL_B, CREDS_B) : [];
const { context: ctxA, account: accountA } = await contextFor(URL_A, LABEL_A, candidatesA);
const { context: ctxB, account: accountB } = await contextFor(URL_B, LABEL_B, candidatesB);

if (WITH_AUTH) {
  const who = (acc, cand) => (acc ? `${acc.email} (${acc.source})` : cand.length ? `not signed in — ${cand[0].email} was refused` : 'no account');
  authNote = `${LABEL_A}: ${who(accountA, candidatesA)} · ${LABEL_B}: ${who(accountB, candidatesB)}`;
  console.log(`   👤 ${authNote}`);

  // Both sides must be signed in, or there is nothing worth comparing: every
  // page in the inventory is a learner's own page, so a side that is logged out
  // shows the public site and EVERY row differs. That report reads like a
  // catastrophic regression and is pure noise — stop instead of producing it.
  if (!accountA || !accountB) {
    const down = !accountA ? LABEL_A : LABEL_B;
    console.error(`\n${'═'.repeat(70)}`);
    console.error(`  ✖ Not signed in on ${down} — nothing was compared.`);
    console.error(`${'═'.repeat(70)}`);
    console.error(`\n  ${authNote}\n`);
    console.error('  Every compared page is a signed-in page, so comparing a logged-out side');
    console.error('  against a signed-in one would report every row as a difference.\n');
    console.error('  Check, in this order:');
    console.error(`    1. Is the environment up?   curl -I ${!accountA ? URL_A : URL_B}/public/login`);
    console.error(`    2. Does the account exist there?   npm run compare -- --users`);
    console.error(`    3. Make a fresh pair:   npm run create:pair -- <ORG>\n`);
    console.error('  --allow-logged-out runs it anyway, if a logged-out capture is what you want.\n');
    await browser.close().catch(() => {});
    if (!has('--allow-logged-out')) process.exit(2);
  }
}

const pageA = await ctxA.newPage();
const pageB = await ctxB.newPage();

const results = [];
for (const [i, route] of routes.entries()) {
  process.stdout.write(`  [${i + 1}/${routes.length}] ${route.name.padEnd(22)} `);
  const opts = { shotDir: ASSETS_DIR, fullPage: !NO_FULLPAGE, settle: SETTLE };

  // Both environments are hit at the same moment, so a transient backend blip
  // shows up on both sides instead of looking like a regression on one.
  const [A, B] = await Promise.all([
    capture(pageA, route, URL_A, { ...opts, prefix: 'a' }).then(applyIgnores).catch((e) => errorCapture(route, URL_A, e)),
    capture(pageB, route, URL_B, { ...opts, prefix: 'b' }).then(applyIgnores).catch((e) => errorCapture(route, URL_B, e)),
  ]);

  let pixel = null;
  let diffImage = '';
  if (A.shots?.viewport && B.shots?.viewport) {
    const outName = `diff_${route.id}.png`;
    pixel = pixelDiff(
      resolve(ASSETS_DIR, A.shots.viewport),
      resolve(ASSETS_DIR, B.shots.viewport),
      resolve(ASSETS_DIR, outName),
      { tolerance: 24, minPercent: THRESHOLD },
    );
    if (pixel.wrote) diffImage = outName;
  }

  const r = diffRoute(route, A, B, { labelA: LABEL_A, labelB: LABEL_B, pixelThreshold: THRESHOLD, pixel });
  r.diffImage = diffImage;
  results.push(r);

  const mark = { error: '❌', warn: '⚠️ ', info: 'ℹ️ ', same: '✅' }[r.worst];
  const px = pixel && !pixel.unavailable && !pixel.sizeMismatch ? ` · ${pixel.percent.toFixed(2)}% pixels` : '';
  console.log(`${mark} ${r.findings.length} finding${r.findings.length === 1 ? '' : 's'}${px}`);
}

function errorCapture(route, baseUrl, e) {
  return {
    routeId: route.id,
    url: baseUrl + route.path,
    finalUrl: baseUrl + route.path,
    redirected: false,
    status: 0,
    navError: String(e?.message || e).slice(0, 300),
    timings: { domReadyMs: 0, idleMs: 0 },
    consoleErrors: [], consoleWarnings: [], pageErrors: [], failedRequests: [],
    shots: {}, headings: [], buttons: [], links: [], fields: [], bundles: [],
    counts: {}, brokenImages: [], text: '', textLength: 0, isBlank: true,
  };
}

// ── journeys: walk the flow on both sides, comparing at every step ────
const skippedWrites = [];
for (const raw of journeys) {
  const stamp = String(startedAt.getTime()).slice(-6);
  const journey = withVars(raw, { stamp, email: `cmp${stamp}@yopmail.com` });
  const { steps, skipped } = stepsFor(journey, ALLOW_WRITES);
  if (skipped.length) skippedWrites.push({ journey: journey.name, steps: skipped.map((s) => s.label) });

  console.log(`\n  🚶 Journey: ${journey.name} — ${steps.length} step${steps.length === 1 ? '' : 's'}` +
    (skipped.length ? ` (${skipped.length} write step(s) skipped — add --allow-writes to include them)` : ''));

  const opts = { shotDir: ASSETS_DIR, fullPage: !NO_FULLPAGE, steps };
  const [walkA, walkB] = await Promise.all([
    walk(pageA, journey, URL_A, { ...opts, prefix: 'a' }).catch((e) => { console.log(`     ✖ ${LABEL_A}: ${e.message}`); return []; }),
    walk(pageB, journey, URL_B, { ...opts, prefix: 'b' }).catch((e) => { console.log(`     ✖ ${LABEL_B}: ${e.message}`); return []; }),
  ]);

  for (const [i, step] of steps.entries()) {
    const A = applyIgnores(walkA[i] || errorCapture({ id: `${journey.id}-s${i + 1}`, path: journey.path }, URL_A, new Error('step not reached')));
    const B = applyIgnores(walkB[i] || errorCapture({ id: `${journey.id}-s${i + 1}`, path: journey.path }, URL_B, new Error('step not reached')));

    const stepRoute = {
      id: `${journey.id}-s${i + 1}`,
      name: `${journey.name} · ${step.label}`,
      path: journey.path,
      auth: journey.auth,
      journey: journey.name,
      note: step.do?.length
        ? `Reached by: ${step.do.map(describeAction).join(', ')}.`
        : 'The screen the journey starts on.',
    };

    let pixel = null;
    let diffImage = '';
    if (A.shots?.viewport && B.shots?.viewport) {
      const outName = `diff_${stepRoute.id}.png`;
      pixel = pixelDiff(
        resolve(ASSETS_DIR, A.shots.viewport),
        resolve(ASSETS_DIR, B.shots.viewport),
        resolve(ASSETS_DIR, outName),
        { tolerance: 24, minPercent: THRESHOLD },
      );
      if (pixel.wrote) diffImage = outName;
    }

    const r = diffRoute(stepRoute, A, B, { labelA: LABEL_A, labelB: LABEL_B, pixelThreshold: THRESHOLD, pixel });
    r.diffImage = diffImage;
    results.push(r);

    const mark = { error: '❌', warn: '⚠️ ', info: 'ℹ️ ', same: '✅' }[r.worst];
    const px = pixel && !pixel.unavailable && !pixel.sizeMismatch ? ` · ${pixel.percent.toFixed(2)}% pixels` : '';
    console.log(`     ${mark} ${step.label.padEnd(30)} ${r.findings.length} finding${r.findings.length === 1 ? '' : 's'}${px}`);
  }
}

function describeAction(a) {
  if (a.click) return `click "${a.click}"`;
  if (a.fill) return `type into ${a.fill.split(',')[0]}`;
  if (a.waitFor) return `wait for "${a.waitFor}"`;
  return `wait ${a.wait} ms`;
}

// ── API parity ────────────────────────────────────────────────────────
const apiResults = [];
if (apiEndpoints.length) {
  console.log('\n  API parity …');
  for (const ep of apiEndpoints) {
    const [a, b] = await Promise.all([probeApi(new URL(URL_A).origin, ep), probeApi(new URL(URL_B).origin, ep)]);
    const r = diffApi(a, b, LABEL_A, LABEL_B);
    apiResults.push(r);
    console.log(`    ${r.worst === 'same' ? '✅' : r.worst === 'error' ? '❌' : 'ℹ️ '} ${ep.name.padEnd(20)} ${a.status}/${b.status}  count ${a.count ?? '—'}/${b.count ?? '—'}`);
  }
}

// ── catalogue parity ──────────────────────────────────────────────────
let catalogue = null;
if (!NO_CATALOGUE) {
  console.log('\n  Course catalogue parity …');
  const [ca, cb] = await Promise.all([
    loadCourses(new URL(URL_A).origin, { refresh: REFRESH, print: () => {} }).catch(() => []),
    loadCourses(new URL(URL_B).origin, { refresh: REFRESH, print: () => {} }).catch(() => []),
  ]);
  if (ca.length || cb.length) {
    catalogue = diffCatalogue(ca, cb, LABEL_A, LABEL_B);
    console.log(`    ${LABEL_A}: ${catalogue.totalA} · ${LABEL_B}: ${catalogue.totalB} · only-A ${catalogue.onlyA.length} · only-B ${catalogue.onlyB.length}`);
  } else {
    console.log('    (catalogue unavailable on both environments — skipped)');
  }
}

// ── report ────────────────────────────────────────────────────────────
const durationMs = Date.now() - startedAt.getTime();
const reportData = {
  labelA: LABEL_A, labelB: LABEL_B, urlA: URL_A, urlB: URL_B,
  routes: results, api: apiResults, catalogue,
  assetsDir: ASSETS_NAME,
  startedAt: startedAt.toLocaleString(),
  durationMs,
  authNote,
  skippedWrites,
};

const htmlPath = resolve(OUT_DIR, `${RUN_NAME}.html`);
const simplePath = resolve(OUT_DIR, `${RUN_NAME}_SIMPLE.html`);
const textPath = resolve(OUT_DIR, `${RUN_NAME}_SIMPLE.txt`);
const jsonPath = resolve(OUT_DIR, `${RUN_NAME}.json`);
writeFileSync(htmlPath, renderReport(reportData), 'utf-8');
// The plain-language pair: side-by-side columns + pictures, and the same thing
// as text for pasting into a ticket or an email.
writeFileSync(simplePath, renderSimpleHtml(reportData), 'utf-8');
writeFileSync(textPath, renderText(reportData), 'utf-8');
writeFileSync(jsonPath, JSON.stringify({
  startedAt: startedAt.toISOString(), durationMs,
  envA: { label: LABEL_A, url: URL_A }, envB: { label: LABEL_B, url: URL_B },
  auth: WITH_AUTH, authNote,
  routes: results.map((r) => ({
    id: r.route.id, name: r.route.name, path: r.route.path, worst: r.worst,
    findings: r.findings,
    pixelPercent: r.pixel && !r.pixel.unavailable && !r.pixel.sizeMismatch ? r.pixel.percent : null,
    a: slimCapture(r.A), b: slimCapture(r.B),
  })),
  api: apiResults.map((r) => ({ id: r.a.id, worst: r.worst, a: r.a, b: r.b, findings: r.findings })),
  catalogue,
}, null, 2), 'utf-8');

// ── PDF (printed from the simple report, so it reads the same) ────────
const pdfPath = resolve(OUT_DIR, `${RUN_NAME}_SIMPLE.pdf`);
let pdfWritten = false;
if (!NO_PDF) {
  process.stdout.write('\n🖨  Printing the simple report to PDF … ');
  try {
    const pdfPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    // PRINT media, set BEFORE the page lays out.
    //
    // This printed with media:'screen', so the report's own @media print rules —
    // page-break-inside, the image height cap — were ignored, and the PDF broke
    // pages mid-screenshot and scaled images differently from the HTML. Colours
    // survive because the print block sets print-color-adjust and pdf() is
    // called with printBackground.
    await pdfPage.emulateMedia({ media: 'print' });
    await pdfPage.goto(pathToFileURL(simplePath).href, { waitUntil: 'networkidle', timeout: 120000 });

    // Every screenshot is loading="lazy", so the ones below the fold had never
    // been fetched when the PDF was taken and came out blank. Load them all and
    // wait for the pixels to actually be decoded.
    await pdfPage.evaluate(async () => {
      const imgs = Array.from(document.images);
      imgs.forEach((img) => { img.loading = 'eager'; });
      await Promise.all(imgs.map((img) => (img.complete ? img.decode().catch(() => {}) : new Promise((res) => {
        img.addEventListener('load', res, { once: true });
        img.addEventListener('error', res, { once: true });
      }))));
    }).catch(() => {});
    await pdfPage.waitForTimeout(1200);
    await pdfPage.pdf({
      path: pdfPath,
      format: 'A4',
      landscape: true,
      printBackground: true,
      margin: { top: '10mm', bottom: '12mm', left: '8mm', right: '8mm' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate:
        '<div style="width:100%;font-family:Segoe UI,Arial,sans-serif;font-size:8pt;color:#7C8696;padding:0 10mm;">' +
        `<span style="float:left;">${LABEL_A} vs ${LABEL_B} — ${startedAt.toLocaleString()}</span>` +
        '<span style="float:right;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>',
    });
    await pdfPage.close();
    pdfWritten = true;
    console.log('done');
  } catch (e) {
    console.log(`failed (${e.message.slice(0, 120)})`);
  }
}

await browser.close().catch(() => {});

function slimCapture(c) {
  return {
    status: c.status, finalUrl: c.finalUrl, navError: c.navError, timings: c.timings,
    counts: c.counts, consoleErrors: c.consoleErrors, pageErrors: c.pageErrors,
    failedRequests: c.failedRequests, title: c.title, lang: c.lang, shots: c.shots,
  };
}

const blocking = results.filter((r) => r.worst === 'error').length +
  apiResults.filter((r) => r.worst === 'error').length;
const review = results.filter((r) => r.worst === 'warn').length;
const identical = results.filter((r) => r.worst === 'same').length;

console.log(`\n${'═'.repeat(70)}`);
const minor = results.filter((r) => r.worst === 'info').length;
console.log(`  ${LABEL_A} vs ${LABEL_B} — ${blocking} P1 broken · ${review} P2 major · ${minor} P3 minor · ${identical} identical`);
console.log(`${'═'.repeat(70)}`);
console.log(`\n📗 Simple report (side-by-side, plain English) : ${simplePath}`);
console.log(`📄 Same thing as text                         : ${textPath}`);
if (pdfWritten) console.log(`📕 Same thing as PDF                          : ${pdfPath}`);
console.log(`📊 Detailed report                            : ${htmlPath}`);
console.log(`🧾 JSON (for CI)                              : ${jsonPath}`);
console.log(`🖼  Images                                     : ${ASSETS_DIR}\n`);

if (existsSync(simplePath) && has('--open')) {
  // Open the plain-English one — that is the report people actually read.
  const { spawn } = await import('node:child_process');
  const opener = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', simplePath]]
    : process.platform === 'darwin'
      ? ['open', [simplePath]]
      : ['xdg-open', [simplePath]];
  spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref();
}

process.exit(blocking ? 1 : 0);
