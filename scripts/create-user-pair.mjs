/**
 * One user per environment, same org — a matched pair.
 * ────────────────────────────────────────────────────
 * Production and staging run separate backends, so an account created on one
 * cannot sign in to the other. This provisions the SAME org (and role) on BOTH,
 * each through that environment's own provisioning API and token, and stamps
 * the staging one so the pair is easy to tell apart:
 *
 *   production   BNRC-ANM007@yopmail.com          Aastrika User
 *   staging      STAGE-BNRC-ANM001@yopmail.com    Stage User
 *
 * Each account is signed in through a FRESH incognito context before it counts
 * as created, so a half-provisioned account is reported as a failure rather
 * than sitting in created-users.txt looking usable.
 *
 *   npm run create:pair                 (prompts for the org)
 *   npm run create:pair -- BNRC         BNRC on both environments
 *   npm run create:pair -- BNRC --prod-only | --stage-only
 *   npm run create:pair -- MP --role CHO-MP
 *
 * The default pair is production + staging, but any two (or more) environments
 * can be named explicitly — the comparison runner uses this to mint the pair on
 * exactly the two environments it is comparing (e.g. production + UAT):
 *
 *   npm run create:pair -- BNRC --env https://ekshamata.aastrika.org \
 *                                --env https://ekshamata-uat.aastrika.org
 *
 * The environments run one after the other: they share created-users.txt and
 * email-counters.json, and two writers would interleave their lines.
 */
import { readFileSync } from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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
const INTERACTIVE = (process.stdin.isTTY && process.stdout.isTTY) || process.env.PAIR_INTERACTIVE === '1';

const ENVIRONMENTS = [
  ['Production', 'https://ekshamata.aastrika.org'],
  ['Staging', 'https://ekshamata-staging.aastrika.org'],
];

/** A display name for any environment URL, known or not. */
const NAME_BY_HOST = {
  'ekshamata.aastrika.org': 'Production',
  'ekshamata-staging.aastrika.org': 'Staging',
  'ekshamata-uat.aastrika.org': 'UAT',
  localhost: 'Localhost',
  '127.0.0.1': 'Localhost',
};
function nameFor(url) {
  const host = new URL(url).hostname;
  if (NAME_BY_HOST[host]) return NAME_BY_HOST[host];
  if (/-uat\./i.test(host)) return 'UAT';
  if (/staging/i.test(host)) return 'Staging';
  return host;
}

function ask(query) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(query, (a) => { rl.close(); res((a || '').trim()); });
  });
}

/** Org keys + their designations, read from the registry. */
function parseOrgs() {
  const src = readFileSync(resolve(ROOT, 'src/config/orgs.ts'), 'utf-8');
  const orgs = {};
  const re = /key:\s*'([^']+)'[\s\S]*?designations:\s*\[([\s\S]*?)\]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const designations = [...m[2].matchAll(/designation:\s*'([^']+)'/g)].map((d) => d[1]);
    if (designations.length) orgs[m[1]] = designations;
  }
  return orgs;
}

const orgs = parseOrgs();
const keys = Object.keys(orgs);

// ── org ──
let org = (argv.find((a) => !a.startsWith('--') && keys.includes(a.toUpperCase())) || '').toUpperCase();
if (!org) {
  if (!INTERACTIVE) {
    console.error(`\n✖ Name an org: npm run create:pair -- <ORG>\n  ${keys.join(' · ')}\n`);
    process.exit(1);
  }
  console.log('\n🏢 Which org?\n');
  keys.forEach((k, i) => console.log(`  ${String(i + 1).padStart(2)}. ${k.padEnd(12)} ${orgs[k].join(' · ')}`));
  const sel = await ask('\n  Number or name (Enter = BNRC) : ');
  org = !sel ? 'BNRC' : /^\d+$/.test(sel) ? keys[Number(sel) - 1] : sel.toUpperCase();
  if (!keys.includes(org)) { console.error(`\n✖ Unknown org "${sel}".\n`); process.exit(1); }
}

// ── role (only asked when the org has more than one) ──
let role = flag('--role', '');
if (!role && orgs[org].length > 1 && INTERACTIVE) {
  console.log(`\n👔 ${org} has ${orgs[org].length} roles:\n`);
  orgs[org].forEach((d, i) => console.log(`  ${i + 1}. ${d}`));
  const sel = await ask(`\n  Number or name (Enter = ${orgs[org][0]}) : `);
  role = !sel ? orgs[org][0] : /^\d+$/.test(sel) ? orgs[org][Number(sel) - 1] : sel;
}
if (role && !orgs[org].includes(role)) {
  console.error(`\n✖ "${role}" is not a ${org} role. Try: ${orgs[org].join(' · ')}\n`);
  process.exit(1);
}

// ── which environments ──
// Explicit --env URLs win: the comparison runner passes the exact two it is
// comparing, so the pair lands on THOSE (e.g. production + UAT) rather than on
// the default production + staging. --prod-only / --stage-only still narrow the
// default pair when no --env is given.
const envUrls = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--env' && argv[i + 1]) envUrls.push(argv[++i]);
}
const targets = envUrls.length
  ? envUrls.map((u) => [nameFor(u), u.replace(/\/+$/, '')])
  : ENVIRONMENTS.filter(([name]) =>
      (name === 'Production' && !has('--stage-only')) || (name === 'Staging' && !has('--prod-only')));

const cli = require.resolve('@playwright/test/cli');

/** Provision on ONE environment. Resolves to its exit code. */
function provision(name, baseUrl) {
  return new Promise((res) => {
    console.log(`\n${'─'.repeat(68)}\n  ${name} — ${baseUrl}\n${'─'.repeat(68)}`);
    const child = spawn(
      process.execPath,
      [cli, 'test', 'tests/create-env-user.spec.ts', '--project=Chrome', '--reporter=line', ...(has('--headed') ? ['--headed'] : [])],
      {
        cwd: ROOT,
        stdio: 'inherit',
        env: {
          ...process.env,
          // BASE_URL selects the backend AND its token — see src/api/Ekshamata-api.ts.
          BASE_URL: baseUrl,
          CREATE_ORG: org,
          CREATE_DESIGNATION: role || '',
          HEADLESS: has('--headed') ? 'false' : 'true',
        },
      },
    );
    child.on('exit', (code) => res(code ?? 1));
  });
}

console.log(`\n👥 Creating a ${org}${role ? ` (${role})` : ''} user on ${targets.map(([n]) => n).join(' and ')}.`);

const failed = [];
for (const [name, url] of targets) {
  const code = await provision(name, url);
  if (code !== 0) failed.push(name);
}

// ── what came out ──
const lines = readFileSync(resolve(ROOT, 'created-users.txt'), 'utf-8').trim().split(/\r?\n/).slice(-targets.length * 2);
console.log(`\n${'═'.repeat(68)}\n  The pair\n${'═'.repeat(68)}`);
for (const [name, url] of targets) {
  const host = new URL(url).hostname;
  const mine = lines.filter((l) => l.includes(`env=${host}`)).pop();
  const parts = (mine || '').split('|').map((s) => s.trim());
  console.log(`  ${name.padEnd(11)} ${parts[3] ? `${parts[3]}  /  ${parts[4]}  (${parts[2]})` : failed.includes(name) ? 'not created' : 'see the log above'}`);
}
console.log();

if (failed.length) {
  console.error(`✖ ${failed.join(' and ')} failed — the account was not created, or it could not sign in there.\n`);
  process.exit(1);
}
