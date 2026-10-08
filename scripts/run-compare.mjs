/**
 * Interactive environment-comparison runner.
 * ──────────────────────────────────────────
 * Asks everything scripts/compare-env.mjs needs, then runs it:
 *
 *   1. WHICH TWO ENVIRONMENTS to put side by side (or any full URL)
 *   2. WHICH ORG both sides sign in as — then a FRESH user is provisioned on
 *      EACH environment and the comparison is pinned to exactly those two
 *      (reusing the existing pair is offered as an alternative)
 *   3. WHICH FEATURES to compare (all four, or a subset)
 *   4. The run options — visual threshold, headed, open report
 *
 * Every page compared is a signed-in one, so an org is always chosen. The two
 * environments are separate backends: each has its OWN account for that org,
 * and comparing across different orgs would report one learner's plan against
 * another's as if it were environment drift.
 *
 * It prints the equivalent one-liner before running, so anything you set up
 * here can be repeated (or dropped into CI) without the prompts.
 *
 *   npm run compare                 (prompts)
 *   npm run compare -- --auth ...   (any flag skips the prompts entirely)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createdUsersOn } from './lib/env-login.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);
require('dotenv').config({ path: resolve(ROOT, '.env') });

const COMPARE = resolve(__dirname, 'compare-env.mjs');
const CONFIG = resolve(ROOT, 'config', 'compare-routes.json');
const JOURNEYS = resolve(ROOT, 'config', 'compare-journeys.json');
const argv = process.argv.slice(2);
// Prompts need a real terminal. COMPARE_INTERACTIVE=1 forces them on when the
// answers are piped in (a wrapper script, or a scripted check of this flow).
const INTERACTIVE = (process.stdin.isTTY && process.stdout.isTTY) || process.env.COMPARE_INTERACTIVE === '1';

/**
 * Prompting that works whether a person is typing or the answers are piped in.
 *
 * A fresh readline per question loses piped input: the first interface buffers
 * the whole pipe, so every later prompt sees EOF and the run stops at question
 * one. Lines are queued here as they arrive and each question takes the next,
 * so both work — a person answering, and a scripted check of this flow.
 */
let rl = null;
const pending = [];
let waiting = null;
let stdinClosed = false;

function prompts() {
  if (!rl) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY),
    });
    rl.on('line', (line) => {
      const answer = (line || '').trim();
      if (waiting) { const resolve = waiting; waiting = null; resolve(answer); }
      else pending.push(answer);
    });
    rl.on('close', () => {
      stdinClosed = true;
      if (waiting) { const resolve = waiting; waiting = null; resolve(''); }
    });
  }
  return rl;
}

function ask(query) {
  prompts();
  process.stdout.write(query);
  if (pending.length) {
    const answer = pending.shift();
    if (!process.stdin.isTTY) process.stdout.write(`${answer}\n`);
    return Promise.resolve(answer);
  }
  if (stdinClosed) return Promise.resolve('');
  return new Promise((res) => { waiting = res; });
}

/** Hand the terminal back before the comparison takes over stdio. */
function closePrompts() {
  if (rl) { rl.close(); rl = null; }
}
const yes = (answer, dflt = true) => (answer === '' ? dflt : /^y/i.test(answer));

function run(args) {
  closePrompts();
  return new Promise((res) => {
    const child = spawn(process.execPath, [COMPARE, ...args], { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code) => res(code ?? 1));
  });
}

// ══════════════════════════════════════════════════════════════════════
// 1. ENVIRONMENTS
// ══════════════════════════════════════════════════════════════════════
const ENVIRONMENTS = [
  ['Production', 'https://ekshamata.aastrika.org'],
  ['Staging', 'https://ekshamata-staging.aastrika.org'],
  ['UAT',     'https://ekshamata-uat.aastrika.org'],
  ['Localhost', 'http://localhost:3000'],
];

async function pickEnv(which, dflt) {
  console.log(`\n🌐 ${which} environment\n`);
  ENVIRONMENTS.forEach(([name, url], i) => console.log(`  ${i + 1}. ${name.padEnd(11)} ${url}`));
  const sel = await ask(`\n  Number, name, or a full URL (Enter = ${dflt}) : `);
  let url;
  if (!sel) url = (ENVIRONMENTS.find(([n]) => n === dflt) ?? [])[1];
  else if (/^\d+$/.test(sel)) url = (ENVIRONMENTS[Number(sel) - 1] ?? [])[1];
  else if (/^https?:\/\//i.test(sel)) url = sel;
  else url = (ENVIRONMENTS.find(([n]) => n.toLowerCase().startsWith(sel.toLowerCase())) ?? [])[1];
  if (!url) { console.error(`Invalid environment: "${sel}"`); process.exit(1); }
  return url.replace(/\/+$/, '');
}

// ══════════════════════════════════════════════════════════════════════
// 2. ORG — and the pair of accounts it signs in with
// ══════════════════════════════════════════════════════════════════════
/** Every org in the registry, whether or not it has accounts yet. */
function allOrgs() {
  const src = readFileSync(resolve(ROOT, 'src/config/orgs.ts'), 'utf-8');
  const out = [];
  const re = /key:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return [...new Set(out)];
}

/** The newest account for this org on one environment, or null. */
function accountFor(org, baseUrl) {
  return createdUsersOn(baseUrl).find((u) => (u.orgKey || '').toLowerCase() === org.toLowerCase()) || null;
}

/**
 * Provision a pair on the two environments being compared and wait for it.
 *
 * The exact URLs are passed through so the pair lands on the chosen sides —
 * production + UAT, staging + UAT, etc. — and not on create-user-pair's default
 * production + staging.
 */
function createPair(org, urlA, urlB) {
  return new Promise((res) => {
    const args = [resolve(__dirname, 'create-user-pair.mjs'), org, '--env', urlA, '--env', urlB];
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code) => res(code ?? 1));
  });
}

/**
 * Choose the org, then settle which two accounts sign in.
 *
 * Both sides must be the SAME org or the comparison reads one learner's pages
 * against a different learner's — different learning plans, different courses,
 * all of it reported as environment drift.
 */
async function pickOrg(urlA, urlB) {
  const orgs = allOrgs();
  console.log('\n🏢 Which org should BOTH environments sign in as?\n');
  orgs.forEach((k, i) => {
    const a = accountFor(k, urlA);
    const b = accountFor(k, urlB);
    const mark = a && b
      ? '✔ pair ready'
      : a ? `${new URL(urlA).hostname} only`
      : b ? `${new URL(urlB).hostname} only`
      : '— no accounts yet';
    console.log(`  ${String(i + 1).padStart(2)}. ${k.padEnd(12)} ${mark}`);
  });

  let org = '';
  for (;;) {
    const sel = await ask('\n  Number or name (Enter = BNRC) : ');
    org = !sel ? 'BNRC' : /^\d+$/.test(sel) ? orgs[Number(sel) - 1] : orgs.find((o) => o.toLowerCase() === sel.toLowerCase());
    if (org) break;
    console.log(`  ✖ "${sel}" is not one of: ${orgs.join(' · ')}`);
  }

  // ── the pair of accounts ──
  // A FRESH user on each environment by default. Comparing brand-new accounts
  // of the same org and role is the only way the two sides start equal: an
  // existing account has already started courses, had its org mapping change,
  // or had its password rotated — all of which read as environment drift.
  const before = { a: accountFor(org, urlA), b: accountFor(org, urlB) };
  console.log(`\n👥 ${org} accounts that exist now:`);
  console.log(`   ${new URL(urlA).hostname.padEnd(32)} ${before.a ? `${before.a.email}  (${before.a.designation})` : 'none yet'}`);
  console.log(`   ${new URL(urlB).hostname.padEnd(32)} ${before.b ? `${before.b.email}  (${before.b.designation})` : 'none yet'}`);

  console.log('\n  1. Create a FRESH user on EACH environment and compare those  (Enter)');
  if (before.a && before.b) console.log('  2. Reuse the two above');
  console.log('  3. Paste ONE email and use it on BOTH environments');
  const how = await ask('\n  Number : ');
  if (how === '2' && before.a && before.b) {
    return { org, userA: before.a.email, userB: before.b.email };
  }
  if (how === '3') {
    // One account, both sides. Useful for an account that exists on production
    // AND staging (the long-standing ones do) — and it is how a difference like
    // "the badge shows on production but not on staging" gets compared without
    // the two sides being different learners.
    let email = '';
    for (;;) {
      email = (await ask('\n  Email to use on BOTH environments : ')).trim();
      if (/^[^@\s]+@[^@\s]+$/.test(email)) break;
      if (stdinClosed) { console.error('\n✖ No email given.\n'); process.exit(1); }
      console.log('  ✖ That does not look like an email address.');
    }
    const fallback = process.env.EKSHAMATA_USER_PASSWORD || process.env.EKSHAMATA_PASSWORD || 'Aastrika@123';
    const typed = (await ask(`  Password (Enter = ${fallback}) : `)).trim();
    const password = typed || fallback;

    // COMPARE_EMAIL/COMPARE_PASSWORD are read for BOTH environments, so one
    // answer pins both sides; the child process inherits them.
    process.env.COMPARE_EMAIL = email;
    process.env.COMPARE_PASSWORD = password;
    console.log(`\n✅ Both environments will sign in as ${email}`);
    console.log('   (an account that exists on only one side will be captured logged out there)');
    return { org, userA: email, userB: email, pinnedEmail: email, pinnedPassword: password };
  }

  // Asked ONCE. Everything below is retrying that same answer — no re-confirming.
  for (let attempt = 1; ; attempt++) {
    // Both sides every time: minting only the missing half leaves the other on a
    // stale account, which is how a run ends up signed in as an account that can
    // no longer log in.
    const code = await createPair(org, urlA, urlB);
    const a = accountFor(org, urlA);
    const b = accountFor(org, urlB);

    if (code === 0 && a && b) {
      console.log('\n✅ Comparing as the pair just created:');
      console.log(`   ${new URL(urlA).hostname.padEnd(32)} ${a.email}`);
      console.log(`   ${new URL(urlB).hostname.padEnd(32)} ${b.email}`);
      return { org, userA: a.email, userB: b.email };
    }

    // Never quietly fall back to an older account — that is not the comparison
    // that was asked for. Say which side failed and what can be done about it.
    console.log(`\n  ✖ Attempt ${attempt}: the ${org} pair is not usable.`);
    console.log(`     ${new URL(urlA).hostname.padEnd(32)} ${a ? a.email : 'no account'}`);
    console.log(`     ${new URL(urlB).hostname.padEnd(32)} ${b ? b.email : 'no account'}`);
    console.log('     An account can be created and still fail to sign in — that is a');
    console.log('     backend problem with the environment, not with the account.');
    console.log('\n  1. Create another pair and try again');
    console.log('  2. Pick a different org');
    if (a && b) console.log('  3. Compare with these anyway  (a refused side is captured logged out)');
    console.log('  4. Quit  (Enter)');
    const next = await ask('\n  Number : ');
    if (next === '1') continue;
    if (next === '2') return pickOrg(urlA, urlB);
    if (next === '3' && a && b) return { org, userA: a.email, userB: b.email };
    process.exit(1);
  }
}

// ══════════════════════════════════════════════════════════════════════
// 3. FEATURES
// ══════════════════════════════════════════════════════════════════════
/**
 * Pick the features to compare. Returns { ids, extra } — inventory ids plus
 * any one-off paths typed in.
 */
async function pickFeatures(inventory, withAuth) {
  const all = inventory.routes.filter((r) => !r.skip);
  const available = all.filter((r) => withAuth || !r.auth);
  const hiddenByAuth = all.length - available.length;

  const show = (list) => {
    console.log('\n🧩 Which features should I compare?\n');
    console.log('   0. ALL of them');
    list.forEach((r, i) =>
      console.log(`  ${String(i + 1).padStart(2)}. ${r.name.padEnd(24)} ${r.path}${r.auth ? '   (signed in)' : ''}`));
    if (hiddenByAuth) console.log(`\n  (${hiddenByAuth} signed-in feature(s) hidden — answer "yes" to signing in to include them)`);
    console.log('\n  Type numbers (1,4,6) · a keyword · a path starting with "/" to compare something not listed');
  };

  for (;;) {
    show(available);
    const sel = await ask('\n  Choice (Enter = 0 = all) : ');
    if (!sel || sel === '0') return { ids: [], extra: [] };

    if (sel.startsWith('/')) {
      const path = sel;
      const save = await ask(`  Add "${path}" to config/compare-routes.json for next time? (y/N) : `);
      if (yes(save, false)) {
        const name = (await ask('    Name it : ')) || path;
        addRoute(inventory, { id: slug(name), name, path, auth: withAuth });
        console.log('    ✔ saved');
        return { ids: [slug(name)], extra: [] };
      }
      return { ids: [], extra: [path] };
    }

    if (/^\d+(\s*,\s*\d+)*$/.test(sel)) {
      const picked = [];
      let bad = false;
      for (const part of sel.split(',')) {
        const n = Number(part.trim());
        if (n < 1 || n > available.length) { console.log(`  ✖ ${n} is not in the list.`); bad = true; break; }
        picked.push(available[n - 1].id);
      }
      if (bad) continue;
      return { ids: picked, extra: [] };
    }

    // Anything else: treat as a keyword over name + path.
    const hits = available.filter(
      (r) => r.name.toLowerCase().includes(sel.toLowerCase()) || r.path.toLowerCase().includes(sel.toLowerCase()));
    if (!hits.length) { console.log(`\n  ✖ Nothing matches "${sel}".`); continue; }
    console.log(`\n  Matched: ${hits.map((h) => h.name).join(', ')}`);
    const ok = await ask('  Compare these? (Y/n) : ');
    if (yes(ok)) return { ids: hits.map((h) => h.id), extra: [] };
  }
}

/**
 * Journeys — flows walked step by step on both environments, compared at every
 * screen. Returns { ids, allowWrites, only }.
 */
async function pickJourneys(withAuth) {
  if (!existsSync(JOURNEYS)) return { ids: [], allowWrites: false, only: false };
  const all = (JSON.parse(readFileSync(JOURNEYS, 'utf-8')).journeys || []).filter((j) => !j.skip);
  const available = all.filter((j) => withAuth || !j.auth);
  if (!available.length) return { ids: [], allowWrites: false, only: false };

  console.log('\n🚶 Step-by-step journeys — every screen of a flow compared one by one.\n');
  console.log('   0. None');
  available.forEach((j, i) => {
    const writes = j.steps.filter((s) => s.writes).length;
    console.log(
      `  ${String(i + 1).padStart(2)}. ${j.name.padEnd(24)} ${j.steps.length} steps` +
        `${writes ? `, ${writes} of them create real data` : ''}${j.auth ? '   (signed in)' : ''}`);
  });
  console.log(`  ${String(available.length + 1).padStart(2)}. ALL of them`);

  const sel = await ask('\n  Number(s), e.g. 1 or 1,3 (Enter = none) : ');
  if (!sel || sel === '0') return { ids: [], allowWrites: false, only: false };

  let chosen;
  if (Number(sel) === available.length + 1) chosen = available;
  else {
    chosen = [];
    for (const part of sel.split(',')) {
      const n = Number(part.trim());
      if (n >= 1 && n <= available.length) chosen.push(available[n - 1]);
    }
  }
  if (!chosen.length) { console.log('  ✖ Nothing matched — skipping journeys.'); return { ids: [], allowWrites: false, only: false }; }

  const writeSteps = chosen.flatMap((j) => j.steps.filter((s) => s.writes).map((s) => `${j.name}: ${s.label}`));
  let allowWrites = false;
  if (writeSteps.length) {
    console.log('\n  ⚠️  These steps create real data on BOTH sites (send an OTP, submit a signup):');
    writeSteps.forEach((s) => console.log(`       ${s}`));
    allowWrites = yes(await ask('\n  Perform them anyway? (y/N) : '), false);
  }
  const only = yes(await ask('  Compare ONLY these journeys (skip the page-by-page list)? (Y/n) : '));
  return { ids: chosen.map((j) => j.id), allowWrites, only };
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function addRoute(inventory, route) {
  inventory.routes.push(route);
  writeFileSync(CONFIG, JSON.stringify(inventory, null, 2) + '\n', 'utf-8');
}

// ══════════════════════════════════════════════════════════════════════
// THE PROMPT FLOW
// ══════════════════════════════════════════════════════════════════════
async function interactive() {
  const inventory = JSON.parse(readFileSync(CONFIG, 'utf-8'));

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Ekshamata — compare two environments, feature by feature     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  const urlA = await pickEnv('LEFT (baseline, usually production)', 'Production');
  const urlB = await pickEnv('RIGHT (the one under test, usually staging)', 'Staging');
  if (urlA === urlB) {
    console.error('\n✖ Both sides are the same environment — nothing to compare.\n');
    process.exit(1);
  }

  // ── 2. WHICH ORG signs in ──
  // Every page compared is a signed-in one, and the two environments are
  // separate backends — so the comparison is only meaningful when BOTH sides
  // sign in as the same org. Pick the org, then use its existing pair or mint
  // a fresh one.
  const { org, userA, userB, pinnedEmail, pinnedPassword } = await pickOrg(urlA, urlB);
  // Pin BOTH sides to the exact accounts chosen/created — --org alone would
  // re-resolve 'newest for this org' at run time and could pick a different one.
  const whichUser = ['--org', org, '--user-a', userA, '--user-b', userB];
  const withAuth = true;

  // ── 3. features + journeys ──
  const { ids, extra } = await pickFeatures(inventory, withAuth);
  const journeys = await pickJourneys(withAuth);

  // ── 4. options ──
  // Not asked any more: the answers were the same every single run. Override any
  // of them on the command line — the equivalent one-liner is printed below, so
  // the flag to change is always in front of you.
  const threshold = '0.5';
  const headed = true;      // watch the browsers work
  const catalogue = true;   // compare the course catalogues too
  const freshLogin = withAuth;
  const open = true;        // open the report when it finishes
  console.log('\n⚙️  Options: 0.5% visual threshold · browsers visible · catalogues compared'
    + `${freshLogin ? ' · fresh login' : ''} · report opens at the end`);

  // ── build + show the equivalent command ──
  const args = ['--a', urlA, '--b', urlB];
  if (withAuth) args.push('--auth');
  args.push(...whichUser);
  if (ids.length) args.push('--ids', ids.join(','));
  // A one-off path is compared on its own — not alongside the whole inventory.
  if (extra.length && !ids.length) args.push('--no-inventory');
  if (journeys.ids.length) args.push('--journey', journeys.ids.join(','));
  if (journeys.allowWrites) args.push('--allow-writes');
  if (journeys.only) args.push('--journey-only');
  for (const p of extra) args.push('--route', p);
  if (threshold !== '0.5') args.push('--threshold', threshold);
  if (headed) args.push('--headed');
  if (!catalogue) args.push('--no-catalogue');
  if (freshLogin) args.push('--refresh');
  if (open) args.push('--open');

  const quoted = args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ');
  // A pasted account lives in env vars, not flags — show them, or the printed
  // one-liner would silently compare as somebody else.
  if (pinnedEmail) {
    console.log(`
   $env:COMPARE_EMAIL="${pinnedEmail}"; $env:COMPARE_PASSWORD="${pinnedPassword}"`);
  }
  console.log(`\n▶  Same run without the prompts:\n   npm run compare -- ${quoted}\n`);

  process.exit(await run(args));
}

// Any flag at all means the caller already knows what they want — just run.
// (Declared last so every helper above is initialised before it fires.)
if (argv.length || !INTERACTIVE) {
  process.exit(await run(argv));
} else {
  await interactive();
}
