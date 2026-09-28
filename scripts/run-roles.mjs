/**
 * Interactive role verification sweep.
 *
 * Asks WHICH ENVIRONMENT first (it decides the backend the users are created
 * on — staging and production are separate), then WHICH ROLES to sweep, and
 * runs tests/role-sweep.spec.ts for them.
 *
 *   npm run roles                    (prompts for environment + roles)
 *   npm run roles:all                (prompts for the environment, then sweeps ALL roles)
 *   npm run roles -- MP              (org as an argument; still prompts the env)
 *   BASE_URL=… npm run roles         (skips the environment prompt)
 *   REUSE_USERS=1 npm run roles      (reuse existing accounts instead of minting)
 *   npm run roles -- MP --dry-run    (show what would run, without running it)
 */
import { readFileSync } from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chooseFrom } from './lib/picker.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function ask(query) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(query, (a) => { rl.close(); res((a || '').trim()); });
  });
}

/** Every org x designation, read from the single source of truth. */
function allRoles() {
  const src = readFileSync(resolve(__dirname, '../src/config/orgs.ts'), 'utf-8');
  // Bound each org block by the NEXT `key:` so designations cannot bleed into
  // the previous org (a greedy match here silently mixes them up).
  const re = /key:\s*'([^']+)'([\s\S]*?)(?=\n\s*key:\s*'|\n\};)/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    for (const d of m[2].matchAll(/designation:\s*'([^']+)'/g)) {
      out.push({ org: m[1], designation: d[1], name: `${m[1]} / ${d[1]}` });
    }
  }
  return out;
}

// ── 1. ENVIRONMENT — decides which backend the accounts are created on ──
const BASE_URLS = [
  ['Production (Ekshamata)', 'https://ekshamata.aastrika.org'],
  ['Staging (Ekshamata)',    'https://ekshamata-staging.aastrika.org'],
  ['Localhost',              'http://localhost:3000'],
];

async function pickBaseUrl() {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/+$/, '');
  console.log('\n🌐 Which environment should the sweep run against?\n');
  BASE_URLS.forEach(([name, url], i) => console.log(`  ${i + 1}. ${name.padEnd(24)} ${url}`));
  const sel = await ask('\n  Number, name, or a full https URL (Enter = 1 = Production) : ');
  let url;
  if (!sel) url = BASE_URLS[0][1];
  else if (/^\d+$/.test(sel)) url = (BASE_URLS[Number(sel) - 1] || [])[1];
  else if (/^https?:\/\//i.test(sel)) url = sel.replace(/\/+$/, '');
  else url = (BASE_URLS.find(([n]) => n.toLowerCase().includes(sel.toLowerCase())) || [])[1];
  if (!url) { console.error(`Invalid environment: "${sel}"`); process.exit(1); }
  return url;
}

const BASE_URL = await pickBaseUrl();
console.log(`  → ${BASE_URL}`);

if (/staging/i.test(BASE_URL)) {
  // Staging is a SEPARATE backend with its own provisioning token, so the users
  // this sweep mints there are staging-only accounts — they do not exist on
  // production, and vice versa. Creating and signing them in on staging works
  // (the old login block was resolved on 2026-09-08).
  console.log('\n🧪 Staging: accounts are provisioned on the staging backend with');
  console.log('   SPHERE_STAGING_API_TOKEN, and are tagged STAGE-… so they are easy to');
  console.log('   tell apart from the production ones in created-users.txt.');
}

// ── 2. WHICH ROLES ──────────────────────────────────────────────────
const roles = allRoles();
let grep = '';

// Flags can appear anywhere; only a bare word is an org name.
const SWEEP_ALL = process.argv.includes('--all');
const argOrg = (process.argv.slice(2).find((x) => !x.startsWith('--')) || '').trim();
if (argOrg) {
  const hits = roles.filter((r) => r.org.toLowerCase() === argOrg.toLowerCase());
  if (!hits.length) { console.error(`\n"${argOrg}" is not a known org.`); process.exit(1); }
  grep = hits.map((r) => r.name).join('|');
  console.log(`\n▶  ${hits.length} role(s) for ${argOrg.toUpperCase()}`);
} else if (!SWEEP_ALL) {
  console.log(`\n👥 ${roles.length} roles across ${new Set(roles.map((r) => r.org)).size} orgs.\n`);
  console.log('  1. Sweep ALL roles   (~1 min each)');
  console.log('  2. Pick specific roles');
  const how = await ask('\n  Number (Enter = 1) : ');

  if (how === '2') {
    const picked = await chooseFrom({
      items: roles.map((r) => r.name),
      ask,
      noun: 'role',
      where: new URL(BASE_URL).hostname,
      multi: true,
      pageSize: 25,
    });
    if (!picked.length) { console.error('No roles selected.'); process.exit(1); }
    // Escape regex metacharacters — designations contain "/" and "-".
    grep = picked.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  }
}

const count = grep ? grep.split('|').length : roles.length;
console.log(`\n▶  Role sweep: ${count} role(s) on ${BASE_URL}`);
console.log(`   Reports → test-reports/role-sweep/ (Excel + HTML with homepage captures)\n`);

if (process.argv.includes('--dry-run')) {
  console.log('DRY RUN — would execute:');
  console.log('  BASE_URL=' + BASE_URL);
  console.log('  playwright test tests/role-sweep.spec.ts --project=Chrome' + (grep ? ' -g "' + grep + '"' : ''));
  process.exit(0);
}

const cli = require.resolve('@playwright/test/cli');
const args = [cli, 'test', 'tests/role-sweep.spec.ts', '--project=Chrome'];
if (grep) args.push('-g', grep);

const child = spawn(process.execPath, args, {
  stdio: 'inherit',
  env: { ...process.env, BASE_URL },
});
child.on('exit', (code) => process.exit(code ?? 0));
