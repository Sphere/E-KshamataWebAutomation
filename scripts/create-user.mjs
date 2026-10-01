/**
 * Interactive user provisioning.
 *
 * Prompts for the org, and — when that org has MORE THAN ONE role/designation —
 * asks which role to create the user for. Then runs tests/create-env-user.spec.ts
 * for the chosen environment + org + role: create user → assign role → update
 * profile → sign in from a FRESH incognito context to prove the account works.
 *
 * The account is provisioned on the backend the chosen environment uses, is
 * recorded in created-users.txt with env=<host>, and — on staging — is named
 * STAGE-… so the two environments are easy to tell apart.
 *
 *   npm run create:user            (prompts for org, then role if multiple)
 *   node scripts/create-user.mjs DMHFWUP      (org as arg; still prompts role)
 *
 * Needs the provisioning creds in .env (SPHERE_API_TOKEN + SPHERE_API_COOKIE).
 */
import { readFileSync } from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function ask(query) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(query, (a) => { rl.close(); res((a || '').trim()); });
  });
}

// Parse src/config/orgs.ts for each org's key + its designation list (stable format).
function parseOrgs() {
  const src = readFileSync(resolve(__dirname, '../src/config/orgs.ts'), 'utf-8');
  const orgs = {};
  const re = /key:\s*'([^']+)'[\s\S]*?designations:\s*\[([\s\S]*?)\]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const key = m[1];
    const designations = [...m[2].matchAll(/designation:\s*'([^']+)'/g)].map((d) => d[1]);
    if (designations.length) orgs[key] = designations;
  }
  return orgs;
}

const orgs = parseOrgs();
const keys = Object.keys(orgs);

// ENVIRONMENT FIRST — it selects the backend the account is provisioned on
// (staging and production are separate: a prod-created user cannot log in to
// staging), so everything after this depends on the answer.
const BASE_URLS = [
  ['Production (Ekshamata)', 'https://ekshamata.aastrika.org'],
  ['Staging (Ekshamata)',    'https://ekshamata-staging.aastrika.org'],
  ['UAT (Ekshamata)',        'https://ekshamata-uat.aastrika.org'],
  ['Localhost',              'http://localhost:3000'],
];
let BASE_URL = process.env.BASE_URL && process.env.BASE_URL.replace(/\/+$/, '');
if (!BASE_URL) {
  console.log('\n🌐 Which environment / URL should the scripts run against?\n');
  BASE_URLS.forEach(([name, url], i) => console.log(`  ${i + 1}. ${name.padEnd(24)} ${url}`));
  const sel = await ask('\n  Number, name, or a full https URL (Enter = 1) : ');
  if (!sel) BASE_URL = BASE_URLS[0][1];
  else if (/^\d+$/.test(sel)) BASE_URL = (BASE_URLS[Number(sel) - 1] || [])[1];
  else if (/^https?:\/\//i.test(sel)) BASE_URL = sel.trim().replace(/\/+$/, '');
  else BASE_URL = (BASE_URLS.find(([n]) => n.toLowerCase().includes(sel.toLowerCase())) || [])[1];
  if (!BASE_URL) { console.error(`Invalid URL selection: "${sel}"`); process.exit(1); }
}

let org = (process.argv[2] || '').toUpperCase();
if (!org) {
  console.log(`\n🏢 Orgs: ${keys.join(', ')}`);
  org = (await ask('  Org: ')).toUpperCase();
}
if (!orgs[org]) {
  console.error(`\n"${org}" is not a known org. Choose one of: ${keys.join(', ')}`);
  process.exit(1);
}

const roles = orgs[org];
let designation = roles[0];
if (roles.length > 1) {
  console.log(`\n👤 ${org} has ${roles.length} roles — which one?\n`);
  roles.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
  const sel = await ask('\n  Number or name : ');
  designation = /^\d+$/.test(sel) ? roles[Number(sel) - 1] : roles.find((r) => r.toLowerCase() === sel.toLowerCase());
  if (!designation) { console.error('No role selected.'); process.exit(1); }
} else {
  console.log(`\n👤 ${org} has one role: ${designation}`);
}

console.log(`\n▶  Creating a ${org} user with role "${designation}" on ${BASE_URL}\n`);

const cli = require.resolve('@playwright/test/cli');
const child = spawn(
  process.execPath,
  [cli, 'test', 'tests/create-env-user.spec.ts', '--project=Chrome', '--headed'],
  { stdio: 'inherit', env: { ...process.env, BASE_URL, CREATE_ORG: org, CREATE_DESIGNATION: designation } },
);
child.on('exit', (code) => process.exit(code ?? 0));
