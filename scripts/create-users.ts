/**
 * Provision accounts and print their credentials. NO LOGIN, NO BROWSER.
 * ─────────────────────────────────────────────────────────────────────
 * Just the three provisioning API calls — create user → assign role → update
 * profile — for whichever orgs you name. Nothing is opened in a browser, so a
 * batch of accounts takes seconds rather than a minute each.
 *
 *   npm run create:creds -- --org BNRC              every BNRC role
 *   npm run create:creds -- --org BNRC,SHSB         several orgs
 *   npm run create:creds -- --all                   every org, every role
 *   npm run create:creds -- --org MP --role CHO-MP  one specific role
 *   npm run create:creds -- --all --stage           on staging instead
 *   npm run create:creds -- --org BNRC --count 3    three users for each role
 *
 * Every account is appended to created-users.txt (with env=<host>) exactly as
 * the browser flows record them, and the run also writes a CSV you can hand to
 * someone: test-reports/credentials_<env>_<stamp>.csv
 *
 * The accounts are NOT signed in, so nothing here proves they can log in. Use
 * `npm run create:pair -- <ORG>` when you need that verified.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── arguments ─────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string, fallback = ''): string => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : (argv[i + 1] ?? '');
};
const has = (name: string) => argv.includes(name);

const PROD = 'https://ekshamata.aastrika.org';
const STAGE = 'https://ekshamata-staging.aastrika.org';
const BASE_URL = has('--stage') || has('--staging') ? STAGE : (flag('--url') || PROD);

// The provisioning client reads BASE_URL when it is first imported — to pick the
// backend AND its token — so it must be set before that import happens.
process.env.BASE_URL = BASE_URL;

// eslint-disable-next-line @typescript-eslint/no-var-requires
require('dotenv').config({ path: resolve(__dirname, '..', '.env') });

// Imported with require, AFTER BASE_URL is set above.
/* eslint-disable @typescript-eslint/no-var-requires */
const { ORGS } = require('../src/config/orgs');
const { createOrgUser } = require('../src/utils/user-factory');
/* eslint-enable @typescript-eslint/no-var-requires */

type Variant = { designation: string; emailPrefix: string };

const ALL_ORGS: string[] = Object.keys(ORGS);
const wantedOrgs = has('--all')
  ? ALL_ORGS
  : (flag('--org') || '').split(',').map((o) => o.trim().toUpperCase()).filter(Boolean);
const wantedRole = flag('--role').trim();
const perRole = Math.max(1, Number(flag('--count', '1')) || 1);

if (!wantedOrgs.length) {
  console.error('\n✖ Name the orgs: --org BNRC[,SHSB]  or  --all\n');
  console.error(`  Known orgs: ${ALL_ORGS.join(' · ')}\n`);
  process.exit(1);
}
const unknown = wantedOrgs.filter((o) => !ALL_ORGS.includes(o));
if (unknown.length) {
  console.error(`\n✖ Unknown org(s): ${unknown.join(', ')}\n  Known: ${ALL_ORGS.join(' · ')}\n`);
  process.exit(1);
}

// ── what to create ────────────────────────────────────────────────────
const jobs: { org: string; variant: Variant }[] = [];
for (const org of wantedOrgs) {
  const variants: Variant[] = ORGS[org].designations;
  const chosen = wantedRole ? variants.filter((v) => v.designation === wantedRole) : variants;
  if (wantedRole && !chosen.length) {
    console.error(`\n✖ "${wantedRole}" is not a ${org} role. Try: ${variants.map((v) => v.designation).join(' · ')}\n`);
    process.exit(1);
  }
  for (const variant of chosen) for (let i = 0; i < perRole; i++) jobs.push({ org, variant });
}

const host = new URL(BASE_URL).hostname;
console.log(`\n🔑 Creating ${jobs.length} account(s) on ${host} — credentials only, no login.\n`);

// ── provision ─────────────────────────────────────────────────────────
type Row = { org: string; role: string; email: string; password: string; userId: string; error?: string };

(async () => {
  const rows: Row[] = [];
  for (const [i, job] of jobs.entries()) {
    const label = `${job.org} / ${job.variant.designation}`;
    process.stdout.write(`  [${String(i + 1).padStart(2)}/${jobs.length}] ${label.padEnd(34)}`);
    try {
      const user = await createOrgUser(job.org, job.variant);
      rows.push({ org: job.org, role: job.variant.designation, email: user.email, password: user.password, userId: user.userId });
      console.log(`✅ ${user.email}`);
    } catch (e: any) {
      const message = String(e?.message ?? e).split('\n')[0].slice(0, 120);
      rows.push({ org: job.org, role: job.variant.designation, email: '—', password: '—', userId: '', error: message });
      console.log(`❌ ${message}`);
    }
  }

  // ── the credentials, together ───────────────────────────────────────
  const made = rows.filter((r) => !r.error);
  const failed = rows.filter((r) => r.error);

  console.log(`\n${'═'.repeat(78)}`);
  console.log(`  CREDENTIALS — ${host}`);
  console.log(`${'═'.repeat(78)}`);
  const w = Math.max(...rows.map((r) => `${r.org} / ${r.role}`.length), 20);
  for (const r of made) {
    console.log(`  ${`${r.org} / ${r.role}`.padEnd(w)}  ${r.email.padEnd(36)} ${r.password}`);
  }
  if (failed.length) {
    console.log(`\n  ${failed.length} could not be created:`);
    for (const r of failed) console.log(`  ${`${r.org} / ${r.role}`.padEnd(w)}  ${r.error}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = resolve(__dirname, '..', 'test-reports');
  mkdirSync(outDir, { recursive: true });
  const csvPath = resolve(outDir, `credentials_${host.split('.')[0]}_${stamp}.csv`);
  writeFileSync(
    csvPath,
    ['Org,Role,Email,Password,UserId,Environment,Error',
      ...rows.map((r) => [r.org, r.role, r.email, r.password, r.userId, host, r.error ?? '']
        .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n'),
    'utf-8',
  );

  console.log(`\n  ${made.length} created · ${failed.length} failed`);
  console.log(`  📄 ${csvPath}`);
  console.log('  📄 also appended to created-users.txt');
  console.log('\n  Not signed in — these are provisioned, not verified. To check a login:');
  console.log('     npm run create:pair -- <ORG>\n');

  process.exit(failed.length ? 1 : 0);
})();
