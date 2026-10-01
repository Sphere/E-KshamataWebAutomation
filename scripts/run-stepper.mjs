/**
 * Interactive competency stepper.
 *
 * Asks which ORG and which COMPETENCY to run, then climbs EVERY self-assessment
 * level of that competency (passing each) — provisioning + logging in a fresh
 * user for the chosen org. The web twin of the mobile stepper flow.
 *
 *   npm run run:stepper                 (prompts for URL → org → role → competency)
 *   node scripts/run-stepper.mjs BNRC   (org as arg; still prompts the rest)
 */
import { readFileSync } from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chooseOne } from './lib/picker.mjs';
import { discoverCompetencies } from './lib/competencies.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function ask(query) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(query, (answer) => { rl.close(); res((answer || '').trim()); });
  });
}

/** Parse src/config/orgs.ts for each org's role/designation list. */
function orgRoles() {
  const src = readFileSync(resolve(__dirname, '../src/config/orgs.ts'), 'utf-8');
  const map = {};
  const re = /key:\s*'([^']+)'[\s\S]*?designations:\s*\[([\s\S]*?)\]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    map[m[1]] = [...m[2].matchAll(/designation:\s*'([^']+)'/g)].map((d) => d[1]);
  }
  return map;
}
const ROLES = orgRoles();

// The competency-homepage orgs (their home shows the ANM Learning Plan).
const COMPETENCY_ORGS = ['BNRC', 'DMHUP', 'PVTBIHAR', 'PVTUP', 'SHSB', 'DMHFWUP'];

const require = createRequire(import.meta.url);
const cli = require.resolve('@playwright/test/cli');

// Environments the scripts can run against.
const BASE_URLS = [
  ['Production (Ekshamata)', 'https://ekshamata.aastrika.org'],
  ['Staging (Ekshamata)',    'https://ekshamata-staging.aastrika.org'],
  ['UAT (Ekshamata)',        'https://ekshamata-uat.aastrika.org'],
  ['Localhost',              'http://localhost:3000'],
];
async function pickBaseUrl() {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/+$/, '');
  console.log('\n🌐 Which environment / URL should the stepper run against?\n');
  BASE_URLS.forEach(([name, url], i) => console.log(`  ${i + 1}. ${name.padEnd(24)} ${url}`));
  const sel = await ask('\n  Number, name, or a full https URL (Enter = 1) : ');
  let url;
  if (!sel) url = BASE_URLS[0][1];
  else if (/^\d+$/.test(sel)) url = (BASE_URLS[Number(sel) - 1] || [])[1];
  else if (/^https?:\/\//i.test(sel)) url = sel.trim().replace(/\/+$/, '');
  else url = (BASE_URLS.find(([n]) => n.toLowerCase().includes(sel.toLowerCase())) || [])[1];
  if (!url) { console.error(`Invalid URL selection: "${sel}"`); process.exit(1); }
  return url;
}

/** Ask which language the portal + competency list should be in (asked first). */
async function pickLanguage() {
  // Always resolve to an explicit 'hi' | 'en'. Choosing English has to SET
  // English — the portal language is a persisted account setting, so a previous
  // Hindi run otherwise keeps every later run in Hindi.
  if (process.env.ENSURE_LANG) return process.env.ENSURE_LANG.toLowerCase() === 'hi' ? 'hi' : 'en';
  console.log('\n🗣️  Which language should the portal + competencies be in?\n');
  console.log('  1. हिंदी (Hindi)');
  console.log('  2. English');
  const sel = (await ask('\n  Number or name (Enter = 1 = हिंदी) : ')).trim();
  return /^(2|en|eng|english)$/i.test(sel) ? 'en' : 'hi';
}

// ── Flow ──────────────────────────────────────────────────────────
// ENVIRONMENT FIRST — it decides the backend (staging and production are
// separate), and everything after it — the org's plan, the competency titles —
// is read from whichever one you pick.
const BASE_URL = await pickBaseUrl();
// Then the language: it drives which competency TITLES you'll see.
const ensureLang = await pickLanguage();

let org = (process.argv[2] || '').toUpperCase();
if (!org) {
  console.log(`\n🏢 Which org should I run the stepper for?\n`);
  COMPETENCY_ORGS.forEach((o, i) => console.log(`  ${i + 1}. ${o}`));
  const sel = await ask('\n  Number or name : ');
  org = /^\d+$/.test(sel) ? (COMPETENCY_ORGS[Number(sel) - 1] || '').toUpperCase() : sel.toUpperCase();
}
if (!COMPETENCY_ORGS.includes(org)) {
  console.error(`\n"${org}" is not a competency-homepage org. Choose one of: ${COMPETENCY_ORGS.join(', ')}`);
  process.exit(1);
}

// If the org has more than one role/designation, ask which one to provision as.
const roles = ROLES[org] || [];
let designation = roles[0] || '';
if (roles.length > 1) {
  console.log(`\n👤 ${org} has ${roles.length} roles — which one to run as?\n`);
  roles.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
  const rsel = await ask('\n  Number or name : ');
  designation = /^\d+$/.test(rsel) ? roles[Number(rsel) - 1] : roles.find((r) => r.toLowerCase() === rsel.toLowerCase());
  if (!designation) { console.error('No role selected.'); process.exit(1); }
}

// Language was chosen first (ensureLang), so discovery lists competencies in it.
// The plan is RE-READ on every run: a cached list silently offers competencies
// that no longer exist, or English titles for a Hindi run. Pass --cached to
// reuse the last list instead.
const discoverEnv = { ...process.env, BASE_URL, ORG: org, CREATE_DESIGNATION: designation, ENSURE_LANG: ensureLang };
const { titles, cached } = discoverCompetencies({
  env: discoverEnv, org, lang: ensureLang, cached: process.argv.includes('--cached'),
});
if (!titles.length) {
  console.error(`\nCould not read ${org}'s competencies from the portal. Check the connection/credentials and try again.`);
  process.exit(1);
}

const competency = await chooseOne({
  items: titles,
  ask,
  noun: 'competency',
  where: `${org} · ${ensureLang === 'hi' ? 'हिंदी' : 'English'}${cached ? ' · cached' : ' · live'}`,
});
if (!competency) { console.error('No competency selected.'); process.exit(1); }

const levelsIn = await ask('  Levels (default 5) : ');
const levels = /^\d+$/.test(levelsIn) ? levelsIn : '5';

console.log(`\n▶  ${org}${designation ? ` (${designation})` : ''}: climbing "${competency}" (${levels} levels)` +
  `${ensureLang === 'hi' ? ' in हिंदी' : ' in English'} on ${BASE_URL}\n`);

// Launch Playwright's CLI directly (no npx / cmd shell) so the browser opens sooner.
const child = spawn(
  process.execPath,
  [cli, 'test', 'tests/competency-stepper.spec.ts', '--project=Chrome', '--headed'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      BASE_URL,
      ORG: org,
      COMPETENCY: competency,
      LEVELS: levels,
      CREATE_DESIGNATION: designation,
      ENSURE_LANG: ensureLang,
    },
  },
);
child.on('exit', (code) => process.exit(code ?? 0));
