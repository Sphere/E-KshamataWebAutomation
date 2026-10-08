/**
 * Interactive forgot-password runner.
 * ───────────────────────────────────
 * Asks which environment and which account to reset — pick one of the accounts
 * already in created-users.txt, or type any email yourself — then runs
 * tests/forgot-password.spec.ts against it. The new password is always
 * Sunbird@123.
 *
 *   npm run forgot                 (prompts)
 *   npm run forgot -- <email>      skip the prompt, reset that account
 *
 * The OTP is read live from the account's Yopmail inbox, so the email must be a
 * @yopmail.com address.
 */
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

const NEW_PASSWORD = 'Sunbird@123';
const SPEC = 'tests/forgot-password.spec.ts';
const argv = process.argv.slice(2);
const INTERACTIVE = (process.stdin.isTTY && process.stdout.isTTY) || process.env.FORGOT_INTERACTIVE === '1';

const ENVIRONMENTS = [
  ['Staging', 'https://ekshamata-staging.aastrika.org'], // the flow was recorded here — default
  ['Production', 'https://ekshamata.aastrika.org'],
  ['UAT', 'https://ekshamata-uat.aastrika.org'],
  ['Localhost', 'http://localhost:3000'],
];

// ── prompting that also works when answers are piped in ──
let rl = null;
const pending = [];
let waiting = null;
let stdinClosed = false;
function prompts() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
    rl.on('line', (line) => {
      const answer = (line || '').trim();
      if (waiting) { const res = waiting; waiting = null; res(answer); }
      else pending.push(answer);
    });
    rl.on('close', () => { stdinClosed = true; if (waiting) { const res = waiting; waiting = null; res(''); } });
  }
  return rl;
}
function ask(query) {
  prompts();
  process.stdout.write(query);
  if (pending.length) return Promise.resolve(pending.shift());
  if (stdinClosed) return Promise.resolve('');
  return new Promise((res) => { waiting = res; });
}
function closePrompts() { if (rl) { rl.close(); rl = null; } }

function run(baseUrl, email) {
  closePrompts();
  const cli = require.resolve('@playwright/test/cli');
  const args = [cli, 'test', SPEC, '--project=Chrome', '--headed'];
  console.log(`\n▶  Same run without the prompts:\n   cross-env BASE_URL=${baseUrl} FORGOT_EMAIL=${email} FORGOT_NEW_PASSWORD=${NEW_PASSWORD} npm run test:forgot\n`);
  return new Promise((res) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, BASE_URL: baseUrl, FORGOT_EMAIL: email, FORGOT_NEW_PASSWORD: NEW_PASSWORD, HEADLESS: 'false' },
    });
    child.on('exit', (code) => res(code ?? 1));
  });
}

async function pickEnv() {
  console.log('\n🌐 Which environment?\n');
  ENVIRONMENTS.forEach(([name, url], i) => console.log(`  ${i + 1}. ${name.padEnd(11)} ${url}`));
  const sel = await ask(`\n  Number, name, or a full URL (Enter = ${ENVIRONMENTS[0][0]}) : `);
  let url;
  if (!sel) url = ENVIRONMENTS[0][1];
  else if (/^\d+$/.test(sel)) url = (ENVIRONMENTS[Number(sel) - 1] ?? [])[1];
  else if (/^https?:\/\//i.test(sel)) url = sel;
  else url = (ENVIRONMENTS.find(([n]) => n.toLowerCase().startsWith(sel.toLowerCase())) ?? [])[1];
  if (!url) { console.error(`✖ Invalid environment: "${sel}"`); process.exit(1); }
  return url.replace(/\/+$/, '');
}

async function pickEmail(baseUrl) {
  const here = createdUsersOn(baseUrl);
  const host = new URL(baseUrl).hostname;

  console.log(`\n📧 Which account to reset?  (accounts created on ${host})\n`);
  if (here.length) {
    here.slice(0, 20).forEach((u, i) =>
      console.log(`  ${String(i + 1).padStart(2)}. ${u.email.padEnd(34)} ${[u.orgKey, u.designation].filter(Boolean).join(' · ')}`));
  } else {
    console.log('  (none in created-users.txt for this environment yet)');
  }
  console.log('\n  Pick a number, or type any email.');

  for (;;) {
    const sel = await ask(`\n  Choice${here.length ? ` (Enter = 1, ${here[0].email})` : ''} : `);
    let email;
    if (!sel && here.length) email = here[0].email;
    else if (/^\d+$/.test(sel)) email = (here[Number(sel) - 1] || {}).email;
    else if (sel) email = sel;

    if (!email) { console.log('  ✖ Not a valid choice — pick a listed number or type an email.'); continue; }
    if (!/@yopmail\.com$/i.test(email)) {
      console.log(`  ⚠️  ${email} is not a @yopmail.com address — the OTP is read from Yopmail, so the reset will stall waiting for a code it cannot see.`);
      const ok = await ask('     Use it anyway? (y/N) : ');
      if (!/^y/i.test(ok)) continue;
    }
    return email;
  }
}

async function interactive() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Ekshamata — forgot password (OTP read live from Yopmail)     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  const baseUrl = await pickEnv();
  const email = await pickEmail(baseUrl);
  console.log(`\n✅ Resetting ${email} on ${new URL(baseUrl).hostname}  →  new password ${NEW_PASSWORD}`);
  process.exit(await run(baseUrl, email));
}

// A bare email argument skips the prompts and resets that account on staging.
const emailArg = argv.find((a) => /@/.test(a));
if (emailArg) {
  process.exit(await run(ENVIRONMENTS[0][1], emailArg));
} else if (!INTERACTIVE) {
  console.error('\n✖ No TTY and no email given.  npm run forgot -- <email@yopmail.com>\n');
  process.exit(1);
} else {
  await interactive();
}
