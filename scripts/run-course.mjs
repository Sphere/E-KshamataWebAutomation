/**
 * Interactive course-completion runner.
 * ─────────────────────────────────────
 * Asks everything tests/course-complete.spec.ts needs, then runs it — and with
 * --certificate-only, drives tests/certificate.spec.ts instead:
 *
 *   1. WHICH ENVIRONMENT — production, staging, localhost, or any URL
 *   2. WHICH COURSE — from that environment's LIVE catalogue (they differ)
 *   3. WHICH ACCOUNT — the .env learner, or one created on production
 *   4. Headed or headless
 *
 * It prints the equivalent one-liner before running, so any run set up here can
 * be repeated (or dropped into CI) without the prompts.
 *
 *   npm run run:course                       (prompts)
 *   npm run courses:list                     list production's courses and exit
 *   npm run courses:list -- --certificates   only the courses that end in a certificate
 *   npm run courses:list -- --stage          list staging's courses and exit
 *   npm run run:course -- --stage --course "Administration of drugs through IV"
 *   npm run run:course -- --no-certificate      finish the course, skip the certificate
 *   npm run run:certificate                     certificate only (course already complete)
 */
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fetchCourses } from './lib/courses.mjs';
import { createdUsers } from './lib/env-login.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);
require('dotenv').config({ path: resolve(ROOT, '.env') });

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(name);
const INTERACTIVE = (process.stdin.isTTY && process.stdout.isTTY) || process.env.COURSE_INTERACTIVE === '1';

const ENVIRONMENTS = [
  ['Production', 'https://ekshamata.aastrika.org'],
  ['Staging', 'https://ekshamata-staging.aastrika.org'],
  ['UAT',     'https://ekshamata-uat.aastrika.org'],
  ['Localhost', 'http://localhost:3000'],
];
/**
 * Prompting that works whether a person is typing or the answers are piped in.
 *
 * `rl.question()` only sees a line that arrives AFTER it is called. Piped input
 * arrives all at once, so every answer but the first was being thrown away and
 * the run stopped at question two. Lines are queued here as they arrive, and a
 * question takes the next one from the queue — so both of these work:
 *
 *   npm run run:certificate                    (a person answers each prompt)
 *   printf '1\n4\n\nn\n' | npm run run:certificate     (a script answers them)
 */
let rl = null;
/** Lines read but not yet asked for. */
const pending = [];
/** Resolver for a question waiting on a line that has not arrived yet. */
let waiting = null;
/** True once stdin has closed: later prompts answer '' rather than hang. */
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
    // Echo it when it was piped in, so the log reads like a real session.
    if (!process.stdin.isTTY) process.stdout.write(`${answer}\n`);
    return Promise.resolve(answer);
  }
  if (stdinClosed) return Promise.resolve('\n');
  return new Promise((res) => { waiting = res; });
}

/** Hand the terminal back before the test run takes over stdio. */
function closePrompts() {
  if (rl) { rl.close(); rl = null; }
}
const yes = (answer, dflt = true) => (answer === '' ? dflt : /^y/i.test(answer));

// ══════════════════════════════════════════════════════════════════════
// 1. ENVIRONMENT
// ══════════════════════════════════════════════════════════════════════
/** The environment from the flags, or null when it has to be asked for. */
function envFromFlags() {
  if (has('--stage') || has('--staging')) return ENVIRONMENTS[1][1];
  if (has('--prod') || has('--production')) return ENVIRONMENTS[0][1];
  if (has('--local')) return ENVIRONMENTS[2][1];
  const url = flag('--url', '');
  if (url) return url.replace(/\/+$/, '');
  return null;
}

async function pickEnv() {
  console.log('\n🌐 Which environment?\n');
  ENVIRONMENTS.forEach(([name, url], i) => console.log(`  ${i + 1}. ${name.padEnd(11)} ${url}`));
  const sel = await ask('\n  Number, name, or a full URL (Enter = Production) : ');
  let url;
  if (!sel) url = ENVIRONMENTS[0][1];
  else if (/^\d+$/.test(sel)) url = (ENVIRONMENTS[Number(sel) - 1] ?? [])[1];
  else if (/^https?:\/\//i.test(sel)) url = sel;
  else url = (ENVIRONMENTS.find(([n]) => n.toLowerCase().startsWith(sel.toLowerCase())) ?? [])[1];
  if (!url) { console.error(`Invalid environment: "${sel}"`); process.exit(1); }
  return url.replace(/\/+$/, '');
}

// ══════════════════════════════════════════════════════════════════════
// 2. COURSE
// ══════════════════════════════════════════════════════════════════════
/**
 * Pick a course from this environment's live catalogue. Production and staging
 * hold different sets, so the list is always fetched for the chosen one.
 *
 * `certificatesOnly` narrows it to the courses that end in a certificate —
 * only a minority do, and the rest can never produce one however long you
 * wait, so a certificate run must not offer them.
 */
async function pickCourse(baseUrl, { certificatesOnly = false } = {}) {
  const origin = new URL(baseUrl).origin;
  const host = new URL(baseUrl).hostname;
  console.log(`\n📚 Reading the live catalogue on ${host} …`);
  const all = await fetchCourses(origin, () => {});
  const courses = certificatesOnly ? all.filter((c) => c.certificate) : all;
  if (!courses.length) {
    console.error(certificatesOnly
      ? `\n✖ None of the ${all.length} live courses on ${host} issue a certificate.\n`
      : `\n✖ No live courses found on ${host}.\n`);
    process.exit(1);
  }
  console.log(certificatesOnly
    ? `\n🏅 ${courses.length} of the ${all.length} courses on ${host} end in a certificate:\n`
    : `\n📚 ${courses.length} live courses on ${host}.`);

  let shown = courses;
  // A list short enough to read is printed in full, so the answer can be a
  // number straight away rather than a search first.
  let listed = false;
  if (courses.length <= 40) {
    courses.forEach((c, i) => console.log(`  ${String(i + 1).padStart(3)}. ${c.name}`));
    listed = true;
  }

  for (;;) {
    const sel = await ask(
      listed
        ? '\n  Number from the list, or a search term : '
        : '\n  Type part of a course name to search (or a number after searching) : ',
    );
    if (!sel) {
      // No answer and no one left to ask: stop rather than loop on empties.
      if (stdinClosed) { console.error('\n✖ No course chosen (no more input).\n'); process.exit(1); }
      console.log('  ✖ Name or number, please.');
      continue;
    }

    if (/^\d+$/.test(sel) && listed) {
      const n = Number(sel);
      if (n >= 1 && n <= shown.length) return shown[n - 1];
      console.log(`  ✖ ${n} is not in the list.`);
      continue;
    }

    const q = sel.toLowerCase();
    const hits = courses.filter((c) => c.name.toLowerCase().includes(q));
    if (!hits.length) {
      console.log(`  ✖ Nothing matches "${sel}"${certificatesOnly ? ' among the certificate courses.' : '.'}`);
      continue;
    }
    if (hits.length === 1) {
      console.log(`\n  → "${hits[0].name}"`);
      if (yes(await ask(certificatesOnly ? '    Complete it and get the certificate? (Y/n) : ' : '    Complete this one? (Y/n) : '))) return hits[0];
      continue;
    }
    shown = hits.slice(0, 40);
    listed = true;
    console.log(`\n  ${hits.length} match "${sel}"${hits.length > 40 ? ' (first 40)' : ''}:\n`);
    shown.forEach((c, i) => console.log(`  ${String(i + 1).padStart(3)}. ${c.name}`));
  }
}

// ══════════════════════════════════════════════════════════════════════
// 3. ACCOUNT
// ══════════════════════════════════════════════════════════════════════
/**
 * Who to run as. Enter keeps the .env learner, which is the account that exists
 * on BOTH backends — accounts created through the API on production cannot
 * always sign in on staging.
 */
async function pickAccount(baseUrl) {
  const envAccount = process.env.EKSHAMATA_EMAIL;
  const ledger = createdUsers();
  const staging = /staging/i.test(baseUrl);

  console.log('\n👤 Run as which learner?');
  if (envAccount) console.log(`   Enter        ${envAccount}   (EKSHAMATA_EMAIL — exists on production and staging)`);
  if (ledger.length) console.log(`   an EMAIL     any of the ${ledger.length} accounts in created-users.txt`);
  if (staging) console.log('   note: accounts created through the API on production may not sign in on staging');

  const pick = await ask('\n  Email, or Enter : ');
  if (!pick) return null; // the spec falls back to EKSHAMATA_EMAIL itself
  const match = ledger.find((u) => u.email.toLowerCase() === pick.toLowerCase());
  if (match) return { email: match.email, password: match.password };

  const password = await ask(`  Password for ${pick} (Enter = ${process.env.EKSHAMATA_USER_PASSWORD ? 'the standard one' : 'EKSHAMATA_PASSWORD'}) : `);
  return { email: pick, password: password || process.env.EKSHAMATA_USER_PASSWORD || process.env.EKSHAMATA_PASSWORD || '' };
}

// ══════════════════════════════════════════════════════════════════════
// RUN
// ══════════════════════════════════════════════════════════════════════
/**
 * Three ways to run, all sharing the same prompts:
 *
 *   (no flag)             complete a course — any of them
 *   --certificate         complete a course that ENDS IN A CERTIFICATE, then
 *                         download it: start/resume, every module, certificate
 *   --certificate-only    skip the course and download the certificate of one
 *                         that is already complete
 *
 * Both certificate modes narrow the course list to the ones that actually issue
 * a certificate — the rest can never produce one however long you wait.
 */
const CERT_ONLY = has('--certificate-only');
const CERT_RUN = has('--certificate') || CERT_ONLY;
const SPEC = CERT_ONLY ? 'tests/certificate.spec.ts' : 'tests/course-complete.spec.ts';

function run(env, headed) {
  closePrompts();
  const cli = require.resolve('@playwright/test/cli');
  // Its OWN artefacts folder per run. Playwright CLEARS the output directory
  // before it starts, and on Windows that blocks — silently, before the first
  // line of output — while another run (or a browser left behind by one that
  // was Ctrl-C'd) still holds files in it. A per-run folder cannot collide.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = `test-results/${SPEC.replace(/^tests\//, '').replace(/\.spec\.ts$/, '')}-${stamp}`;
  const args = [cli, 'test', SPEC, '--project=Chrome', '--output', outDir];
  if (headed) args.push('--headed');
  // --no-certificate: finish the course but stop short of the certificate.
  if (has('--no-certificate')) env = { ...env, CERTIFICATE: '0' };
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
  child.on('exit', (code) => process.exit(code ?? 0));
}

const baseUrl = envFromFlags() ?? (INTERACTIVE ? await pickEnv() : ENVIRONMENTS[0][1]);

// ── --list: just show the catalogue ──
if (has('--list')) {
  const courses = await fetchCourses(new URL(baseUrl).origin, () => {});
  const q = (flag('--course', '') || '').toLowerCase();
  let shown = q ? courses.filter((c) => c.name.toLowerCase().includes(q)) : courses;
  // --certificates: only the courses that end in one.
  const certsOnly = has('--certificates');
  if (certsOnly) shown = shown.filter((c) => c.certificate);
  console.log(`\n${shown.length} live course(s) on ${new URL(baseUrl).hostname}${q ? ` matching "${q}"` : ''}:\n`);
  for (const c of shown) console.log(`  ${c.certificate ? '🏅' : '  '} ${c.name}`);
  if (!certsOnly) {
    const withCert = shown.filter((c) => c.certificate).length;
    console.log(`
  🏅 = ends in a certificate (${withCert} of ${shown.length}). Just those: npm run courses:list -- --certificates`);
  }
  console.log(`\nComplete one:  npm run run:course -- ${/staging/i.test(baseUrl) ? '--stage ' : ''}--course "<name>"\n`);
  process.exit(0);
}

// ── flags only: run straight away ──
const named = flag('--course', '');
if (named || !INTERACTIVE) {
  if (!named && !process.env.COURSE_NAME && !process.env.COURSE_ID) {
    console.error(CERT_ONLY
      ? '\n✖ Name a course: --course "<name>", or $env:COURSE_NAME.'
        + ' Which ones have a certificate: npm run courses:list -- --certificates\n'
      : '\n✖ Name a course: --course "<name>", or $env:COURSE_NAME. List them with: npm run courses:list\n');
    process.exit(1);
  }
  run({ BASE_URL: baseUrl, ...(named ? { COURSE_NAME: named } : {}) }, !has('--headless'));
} else {
  const course = await pickCourse(baseUrl, { certificatesOnly: CERT_RUN });
  const account = await pickAccount(baseUrl);
  const headed = yes(await ask('\n  Watch it run? (Y/n) : '));

  const env = { BASE_URL: baseUrl, COURSE_NAME: course.name, COURSE_ID: course.identifier };
  if (account) { env.COURSE_EMAIL = account.email; env.COURSE_PASSWORD = account.password; }

  const envFlag = baseUrl === ENVIRONMENTS[1][1] ? '--stage ' : baseUrl === ENVIRONMENTS[0][1] ? '' : `--url ${baseUrl} `;
  const cmd = CERT_ONLY ? 'npm run run:certificate:only --'
    : CERT_RUN ? 'npm run run:certificate --'
    : 'npm run run:course --';
  console.log(`\n▶  Same run without the prompts:\n   ${cmd} ${envFlag}--course "${course.name}"${headed ? '' : ' --headless'}\n`);
  console.log(`   "${course.name}" [${course.identifier}] on ${new URL(baseUrl).hostname}\n`);
  run(env, headed);
}
