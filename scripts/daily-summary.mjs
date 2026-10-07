/**
 * One report for the whole "Daily Prod vs Staging Compare" run — and the email.
 * ─────────────────────────────────────────────────────────────────────────
 * The workflow's last job downloads every other job's artifacts into one folder
 * and runs this. It reads:
 *
 *   env-compare-report-<N>/…/compare_production_vs_staging_*.json   (compare job)
 *   daily-test-reports-<env>-<N>/test-reports/results.json          (daily-tests, per env)
 *   daily-signup-<env>-<N>/test-reports/results.json                (daily-signup, per env)
 *   daily-signup-<env>-<N>/generated-emails.txt                      (accounts created)
 *
 * and writes <out>/daily-summary.html (the report — also the email body) and
 * <out>/summary.md (for the run's Summary page). When SMTP_HOST + ALERT_EMAIL_TO
 * are set it emails the report, attaching the compare PDF.
 *
 *   node scripts/daily-summary.mjs --dir all-reports --out daily-summary \
 *     --run-url <url> --run-number <N> --jobs '<toJSON(needs)>'
 *
 * Missing pieces (a job that crashed before uploading) are reported as missing,
 * never fatal: the email must go out even when the run went badly.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const DIR = flag('--dir', 'all-reports');
const OUT = flag('--out', 'daily-summary');
const RUN_URL = flag('--run-url');
const RUN_NUMBER = flag('--run-number', '');
// Product name in the subject and header — the same script serves Sphere and e-Kshamata.
const TITLE = flag('--title', 'Sphere');
let JOBS = {};
try { JOBS = JSON.parse(flag('--jobs', '{}')); } catch { /* ignore */ }

// ── find files ─────────────────────────────────────────────────────────
function walk(dir, out = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    e.isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}
const files = walk(DIR);
const artifactOf = (p) => p.slice(DIR.length + 1).split(/[\\/]/)[0];
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; } };
const stripAnsi = (s) => String(s || '').replace(/\u001b\[[0-9;]*m/g, '');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Playwright results (daily-tests + daily-signup, per environment) ───
/** Flatten a Playwright JSON report into one row per test. */
function flattenPlaywright(report) {
  const rows = [];
  const visit = (suite, file) => {
    const f = suite.file || file;
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        const last = (t.results || []).at(-1) || {};
        // Playwright's own verdict: expected | unexpected | flaky | skipped
        const status = t.status === 'expected' ? 'passed'
          : t.status === 'unexpected' ? 'failed'
          : t.status === 'flaky' ? 'flaky' : 'skipped';
        rows.push({
          file: basename(f || spec.file || ''),
          title: spec.title,
          project: t.projectName,
          status,
          ms: (t.results || []).reduce((a, r) => a + (r.duration || 0), 0),
          error: stripAnsi(last.error?.message || last.errors?.[0]?.message || '').split('\n').find((l) => l.trim()) || '',
          // "difference (…)" annotations: things that differ but are NOT failures
          // (e.g. e-Kshamata staging counts vs production). Runtime annotations
          // can sit on the test or on its result, depending on the Playwright version.
          differences: [...(t.annotations || []), ...(t.results || []).flatMap((r) => r.annotations || [])]
            .filter((a) => /^difference/i.test(a.type || '')).map((a) => a.description || ''),
        });
      }
    }
    for (const s of suite.suites || []) visit(s, f);
  };
  for (const s of report.suites || []) visit(s, s.file);
  return rows;
}

// Friendly names for the artifact prefixes the workflows use.
const JOB_LABELS = {
  'daily-test-reports': 'UI + API tests',
  'daily-signup': 'Signup (create account)',
  'daily-journey': 'New-user journey',
  'daily-orgs': 'Per-org suites',
};
const suites = []; // { job, env, rows, stats }
// results.json is the job's main suite; results-<name>.json is an extra step of
// the same job (e.g. results-create-user.json), reported as its own row.
for (const p of files.filter((f) => /results(-[\w-]+)?\.json$/.test(basename(f)))) {
  const step = (basename(p).match(/^results-([\w-]+)\.json$/) || [])[1];
  const art = artifactOf(p);
  // Any "<job>-<production|staging|uat>-<run>" artifact with a results.json counts.
  const m = art.match(/^(.+?)-(production|staging|uat)-\d+$/);
  if (!m) continue;
  const report = readJson(p);
  if (!report) continue;
  suites.push({
    job: step
      ? step.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
      : JOB_LABELS[m[1]] || m[1].replace(/^daily-/, '').replace(/-/g, ' '),
    env: m[2],
    rows: flattenPlaywright(report),
    durationMs: report.stats?.duration || 0,
  });
}
const count = (rows, s) => rows.filter((r) => r.status === s).length;

// ── compare ────────────────────────────────────────────────────────────
// Every compare in the run — production vs staging and/or production vs UAT.
// The newest report per pair wins (a re-run job leaves an older one behind).
const cmpByPair = new Map();
for (const f of files.filter((p) => /compare_[a-z]+_vs_[a-z]+_[^/\\]*\d\.json$/.test(p)).sort()) {
  const json = readJson(f);
  if (!json?.routes) continue;
  const a = json.envA?.label || 'A', b = json.envB?.label || 'B';
  cmpByPair.set(`${a}|${b}`, { file: f, json, a, b });
}
const cmps = [...cmpByPair.values()];
const cmp = cmps[0]?.json ?? null; // the first, for the single-figure headline
const cmpPdfs = files.filter((f) => /compare_[a-z]+_vs_[a-z]+_.*_SIMPLE\.pdf$/.test(f)).sort();

// ── accounts created this run ──────────────────────────────────────────
// Both ledgers hold the whole history; keep only lines from this run.
//   Sphere      generated-emails.txt   "ISO \t env \t spec \t email"  (older: "ISO \t email")
//   e-Kshamata  created-users.txt      "ISO | ORG | role | email | password | userId | env=host"
const runStart = Date.now() - 6 * 3600_000; // generous: the run is at most a few hours old
// The report job runs in a checkout of the repo, so the COMMITTED ledgers are in
// the working directory. A line already there was not created by this run — it
// was committed beforehand — so it is skipped. (Without this, accounts made
// locally and committed shortly before a run were counted as the run's own.)
const committed = new Set();
for (const f of ['created-users.txt', 'generated-emails.txt']) {
  try { readFileSync(f, 'utf-8').split(/\r?\n/).forEach((l) => l.trim() && committed.add(l.trim())); } catch { /* not in this repo */ }
}
const accounts = [];
for (const p of files.filter((f) => /(generated-emails|created-users)\.txt$/.test(f))) {
  const env = (artifactOf(p).match(/-(production|staging|uat)-/) || [])[1] || '';
  for (const line of readFileSync(p, 'utf-8').split(/\r?\n/)) {
    if (committed.has(line.trim())) continue; // was in the repo before this run
    if (line.includes(' | ')) {
      // Only the email is taken — the password column never goes into the report.
      const c = line.split(' | ').map((x) => x.trim());
      if (Date.parse(c[0]) < runStart || !/@/.test(c[3] || '')) continue;
      const host = (c.find((x) => x.startsWith('env=')) || '').slice(4);
      accounts.push({ when: c[0], env: /staging/i.test(host) ? 'staging' : /(^|-)uat\./i.test(host) ? 'uat' : host ? 'production' : env, source: [c[1], c[2]].filter(Boolean).join(' · '), email: c[3] });
      continue;
    }
    const parts = line.trim().split(/\t/);
    if (parts.length < 2 || Date.parse(parts[0]) < runStart) continue;
    accounts.push({ when: parts[0], env: parts.length >= 4 ? parts[1] : env, source: parts.length >= 4 ? parts[2] : '', email: parts.at(-1) });
  }
}
const uniqueAccounts = [...new Map(accounts.map((a) => [a.email, a])).values()];

// ── headline ───────────────────────────────────────────────────────────
const allRows = suites.flatMap((s) => s.rows.map((r) => ({ ...r, env: s.env, job: s.job })));
const failed = allRows.filter((r) => r.status === 'failed');
// One entry per flagged difference (de-duplicated per env + text).
const differences = [...new Map(allRows.flatMap((r) => (r.differences || []).map((d) => [`${r.env}|${d}`, { env: r.env, file: r.file, text: d }]))).values()];
const jobResults = Object.entries(JOBS).map(([name, v]) => ({ name, result: v?.result || 'unknown' }));
const jobProblem = jobResults.filter((j) => !['success', 'skipped'].includes(j.result));
// Blocking pages, summed over every compare in the run.
const blockingOf = (j) => j.routes.filter((r) => r.worst === 'error').length;
const cmpBlocking = cmps.length ? cmps.reduce((n, c) => n + blockingOf(c.json), 0) : null;
const ok = failed.length === 0 && jobProblem.length === 0;
const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
const subject = ok
  ? `✅ ${TITLE} daily run ${today} — all ${allRows.length - count(allRows, 'skipped')} checks passed`
  : `⚠️ ${TITLE} daily run ${today} — ${failed.length} failed test(s)${jobProblem.length ? `, ${jobProblem.length} job(s) not green` : ''}`;
const fmtMs = (ms) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${Math.round(ms / 1000)}s`);

// ── HTML (inline styles: it is also the email body, and mail clients drop <style>) ──
const C = { navy: '#17283C', teal: '#1E8F8E', teal50: '#E3F7F6', gold: '#F0A500', gold50: '#FEF6E0', bg: '#F6F7F9', border: '#D8DEE5', muted: '#7C8696', text: '#0D1218',
  ok: '#15803D', okBg: '#DCFCE7', warn: '#B45309', warnBg: '#FEF3C7', err: '#B91C1C', errBg: '#FEE2E2' };
const font = "font-family:'Open Sans',Segoe UI,Arial,sans-serif";
const th = `style="background:${C.navy};color:#fff;text-align:left;padding:8px 10px;font-weight:600;font-size:13px"`;
const td = (extra = '') => `style="padding:8px 10px;word-break:break-word;border-bottom:1px solid ${C.border};font-size:13px;vertical-align:top;${extra}"`;
const pill = (label, kind) => {
  const [fg, bg] = kind === 'ok' ? [C.ok, C.okBg] : kind === 'err' ? [C.err, C.errBg] : kind === 'warn' ? [C.warn, C.warnBg] : [C.muted, C.bg];
  return `<span style="display:inline-block;padding:2px 10px;border-radius:9999px;background:${bg};color:${fg};font-weight:600;font-size:12px">${esc(label)}</span>`;
};
const h2 = (t) => `<h2 style="${font};color:${C.navy};font-size:18px;margin:28px 0 10px;padding-bottom:6px;border-bottom:2px solid ${C.teal}">${esc(t)}</h2>`;
const table = (head, rows) => `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;${font};background:#fff;border:1px solid ${C.border};border-radius:8px">`
  + `<tr>${head.map((h) => `<th ${th}>${esc(h)}</th>`).join('')}</tr>${rows.join('')}</table>`;
// Inline blocks, not table cells, so the boxes wrap on a phone instead of overflowing.
const stat = (label, value, color = C.navy) => `<div style="display:inline-block;vertical-align:top;min-width:120px;max-width:200px;margin:0 8px 8px 0;padding:12px 16px;background:#fff;border:1px solid ${C.border};border-radius:8px;${font}">`
  + `<div style="font-size:24px;font-weight:700;color:${color}">${esc(value)}</div><div style="font-size:12px;color:${C.muted}">${esc(label)}</div></div>`;

let html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(TITLE)} daily run</title></head>`
  + `<body style="margin:0;background:${C.bg};${font};color:${C.text}"><div style="max-width:960px;margin:0 auto;padding:24px 16px">`;

html += `<div style="background:${C.navy};color:#fff;border-radius:8px;padding:20px 24px">`
  + `<div style="font-size:12px;color:#BEC5CE;letter-spacing:.5px">${esc(TITLE.toUpperCase())} · DAILY PROD VS STAGING${RUN_NUMBER ? ` · RUN #${esc(RUN_NUMBER)}` : ''}</div>`
  + `<div style="font-size:22px;font-weight:700;margin-top:4px">${esc(subject.replace(/^\S+\s/, ''))}</div>`
  + `<div style="font-size:13px;color:#BEC5CE;margin-top:6px">${esc(new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))} IST`
  + (RUN_URL ? ` · <a href="${esc(RUN_URL)}" style="color:${C.gold}">Open the run on GitHub</a>` : '') + `</div></div>`;

// Headline numbers
html += `<div style="margin-top:12px">`
  + stat('tests passed', count(allRows, 'passed'), C.ok)
  + stat('tests failed', failed.length, failed.length ? C.err : C.navy)
  + stat('skipped', count(allRows, 'skipped'), C.muted)
  + (differences.length ? stat('differences to review (not failures)', differences.length, C.warn) : '')
  + stat('compare: pages with blocking differences', cmpBlocking ?? '—', cmpBlocking ? C.warn : C.navy)
  + stat('accounts created', uniqueAccounts.length, C.teal)
  + `</div>`;

// Jobs
if (jobResults.length) {
  html += h2('Jobs');
  html += table(['Job', 'Result'], jobResults.map((j) => `<tr><td ${td()}>${esc(j.name)}</td><td ${td()}>${pill(j.result, j.result === 'success' ? 'ok' : j.result === 'skipped' ? '' : 'err')}</td></tr>`));
}

// Test results per job × environment
html += h2('Test results by environment');
if (!suites.length) html += `<p style="color:${C.err}">No test results were found — the test jobs may have failed before uploading.</p>`;
const bySuite = suites.sort((a, b) => a.job.localeCompare(b.job) || a.env.localeCompare(b.env));
// The Flaky column only when something was flaky — seven columns overflow a phone.
const anyFlaky = bySuite.some((s) => count(s.rows, 'flaky'));
html += table(['Job', 'Environment', 'Passed', 'Failed', ...(anyFlaky ? ['Flaky'] : []), 'Skipped', 'Time'], bySuite.map((s) => {
  const f = count(s.rows, 'failed');
  return `<tr><td ${td()}>${esc(s.job)}</td><td ${td()}>${esc(s.env)}</td><td ${td(`color:${C.ok};font-weight:600`)}>${count(s.rows, 'passed')}</td>`
    + `<td ${td(f ? `color:${C.err};font-weight:700` : '')}>${f}</td>${anyFlaky ? `<td ${td()}>${count(s.rows, 'flaky')}</td>` : ''}<td ${td(`color:${C.muted}`)}>${count(s.rows, 'skipped')}</td><td ${td()}>${fmtMs(s.durationMs)}</td></tr>`;
}));

// Per spec file, both environments side by side
const specFiles = [...new Set(allRows.map((r) => r.file))].sort();
const envs = [...new Set(suites.map((s) => s.env))].sort();
if (specFiles.length) {
  html += h2('Every spec, side by side');
  html += table(['Spec', ...envs.map((e) => e[0].toUpperCase() + e.slice(1))], specFiles.map((file) => `<tr><td ${td(`font-family:JetBrains Mono,Consolas,monospace;font-size:12px`)}>${esc(file)}</td>`
    + envs.map((env) => {
      const rows = allRows.filter((r) => r.file === file && r.env === env);
      if (!rows.length) return `<td ${td(`color:${C.muted}`)}>—</td>`;
      const f = count(rows, 'failed');
      return `<td ${td()}>${f ? pill(`${f} failed`, 'err') + ' ' : ''}${pill(`${count(rows, 'passed')} passed`, count(rows, 'passed') ? 'ok' : '')}${count(rows, 'skipped') ? ` <span style="color:${C.muted};font-size:12px">${count(rows, 'skipped')} skipped</span>` : ''}</td>`;
    }).join('') + `</tr>`));
}

// Failures, with the reason
html += h2(`Failures (${failed.length})`);
html += failed.length
  ? table(['Environment', 'Test', 'Reason'], failed.map((r) => `<tr><td ${td()}>${esc(r.env)}</td><td ${td()}><div style="font-weight:600">${esc(r.title)}</div><div style="color:${C.muted};font-size:12px">${esc(r.file)} · ${esc(r.project)}</div></td><td ${td(`color:${C.err};font-size:12px`)}>${esc(r.error.slice(0, 300))}</td></tr>`))
  : `<div style="background:${C.okBg};color:${C.ok};border-left:4px solid ${C.ok};padding:10px 14px;border-radius:6px">No test failed.</div>`;

// Compare
// Differences — flagged for review, deliberately NOT styled as failures.
if (differences.length) {
  html += h2(`Differences to review (${differences.length}) — not failures`);
  html += `<div style="background:${C.warnBg};border-left:4px solid ${C.warn};padding:10px 14px;border-radius:6px;margin-bottom:10px;font-size:13px;color:${C.text}">`
    + `These values differ from production. The tests still passed — they are listed for the team to validate.</div>`;
  html += table(['Environment', 'What differs'], differences.map((d) => `<tr><td ${td()}>${esc(d.env)}</td>`
    + `<td ${td()}>${esc(d.text)}<div style="color:${C.muted};font-size:12px">${esc(d.file)}</div></td></tr>`));
}

// One section per compare (production vs staging, production vs UAT…), each
// labelled from the report's own environment names.
if (!cmps.length) {
  html += h2('Environment compare');
  html += JOBS.compare?.result === 'skipped'
    // "production only" runs have nothing to compare production with.
    ? `<p style="color:${C.muted}">Not run — only one environment was selected.</p>`
    : `<p style="color:${C.err}">The compare report is missing — the compare job may have failed.</p>`;
}
for (const { json: cmp, a, b } of cmps) {
  html += h2(`${a} vs ${b} — compared pages`);
  const verdict = (w) => (w === 'error' ? pill('Broken / blocking', 'err') : w === 'warn' ? pill('Different', 'warn') : w === 'info' ? pill('Minor', '') : pill('Same', 'ok'));
  html += table(['Page', 'Verdict', 'What differs'], cmp.routes.map((r) => `<tr><td ${td()}><div style="font-weight:600">${esc(r.name)}</div><div style="color:${C.muted};font-size:12px">${esc(r.path)}</div></td>`
    + `<td ${td()}>${verdict(r.worst)}</td><td ${td('font-size:12px')}>${(r.findings || []).filter((f) => f.severity !== 'info').map((f) => `• ${esc(f.title)}`).join('<br>') || '—'}</td></tr>`));
  if (cmp.api?.length) {
    html += `<h3 style="${font};color:${C.navy};font-size:15px;margin:18px 0 8px">API parity</h3>`;
    html += table(['API', a, b], cmp.api.map((x) => `<tr><td ${td()}>${esc(x.a?.name || x.id)}</td>`
      + `<td ${td()}>${esc(x.a?.status)} · ${esc(x.a?.count ?? '—')} records · ${esc(x.a?.ms)} ms</td><td ${td()}>${esc(x.b?.status)} · ${esc(x.b?.count ?? '—')} records · ${esc(x.b?.ms)} ms</td></tr>`));
  }
  if (cmp.catalogue) {
    const c = cmp.catalogue;
    html += `<div style="background:${C.teal50};border-left:4px solid ${C.teal};padding:10px 14px;border-radius:6px;margin-top:12px;font-size:13px">`
      + `<b>Course catalogue:</b> ${esc(a.toLowerCase())} ${esc(c.totalA)} · ${esc(b.toLowerCase())} ${esc(c.totalB)} · only on ${esc(a.toLowerCase())} ${esc(c.onlyA?.length ?? 0)} · only on ${esc(b.toLowerCase())} ${esc(c.onlyB?.length ?? 0)}</div>`;
  }
}

// Accounts
html += h2(`Accounts created this run (${uniqueAccounts.length})`);
html += uniqueAccounts.length
  ? table(['Environment', 'Created by', 'Email', 'Time (UTC)'], uniqueAccounts.map((a) => `<tr><td ${td()}>${esc(a.env)}</td><td ${td()}>${esc(a.source || 'signup')}</td><td ${td('font-family:JetBrains Mono,Consolas,monospace;font-size:12px')}>${esc(a.email)}</td><td ${td(`color:${C.muted}`)}>${esc(a.when.replace('T', ' ').slice(0, 19))}</td></tr>`))
  : `<p style="color:${C.muted}">None recorded.</p>`;

html += `<p style="color:${C.muted};font-size:12px;margin-top:28px">Full HTML/PDF reports, screenshots and videos for every job are in the run's artifacts${RUN_URL ? ` — <a href="${esc(RUN_URL)}" style="color:#186E6E">open the run</a>` : ''}.</p>`;
html += `</div></body></html>`;

// ── markdown for the run's Summary page ────────────────────────────────
let md = `## ${subject}\n\n| Job | Environment | Passed | Failed | Skipped |\n|---|---|---|---|---|\n`;
for (const s of bySuite) md += `| ${s.job} | ${s.env} | ${count(s.rows, 'passed')} | ${count(s.rows, 'failed')} | ${count(s.rows, 'skipped')} |\n`;
for (const c of cmps) md += `\n**Compare ${c.a} vs ${c.b}:** ${blockingOf(c.json)} of ${c.json.routes.length} compared pages with blocking differences.\n`;
if (failed.length) md += `\n### Failures\n${failed.map((r) => `- **${r.env}** · ${r.file} · ${r.title} — ${r.error.slice(0, 160)}`).join('\n')}\n`;
if (differences.length) md += `\n### Differences to review (not failures)\n${differences.map((d) => `- **${d.env}** · ${d.text}`).join('\n')}\n`;
md += `\nAccounts created: ${uniqueAccounts.length}. The full report is in the **daily-summary-${RUN_NUMBER}** artifact.\n`;

// ── GitHub annotations ─────────────────────────────────────────────────
// GitHub's own "workflow run" notification email lists a job's annotations, so
// the headline results ride along in that email with no SMTP set up at all.
// (GitHub shows at most 10 of each kind per step, so failures are capped.)
if (process.env.GITHUB_ACTIONS) {
  const oneLine = (s) => String(s).replace(/\r?\n/g, ' ').replace(/%/g, '%25');
  const perEnv = bySuite.map((s) => `${s.job} ${s.env}: ${count(s.rows, 'passed')} passed, ${count(s.rows, 'failed')} failed`).join(' · ');
  console.log(`::notice title=Daily run summary::${oneLine(`${subject.replace(/^\S+\s/, '')} — ${perEnv}`)}`);
  for (const c of cmps) console.log(`::notice title=${c.a} vs ${c.b} compare::${oneLine(`${blockingOf(c.json)} of ${c.json.routes.length} compared pages with blocking differences · catalogue ${c.a.toLowerCase()} ${c.json.catalogue?.totalA ?? '?'} / ${c.b.toLowerCase()} ${c.json.catalogue?.totalB ?? '?'}`)}`);
  const shown = uniqueAccounts.slice(0, 10).map((a) => `${a.env}: ${a.email}`).join(" · ");
  console.log(`::notice title=Accounts created (${uniqueAccounts.length})::${oneLine(uniqueAccounts.length ? shown + (uniqueAccounts.length > 10 ? ` · … ${uniqueAccounts.length - 10} more in the report` : "") : "none")}`);
  for (const r of failed.slice(0, 9)) console.log(`::error title=${oneLine(`Failed on ${r.env}: ${r.file}`)}::${oneLine(`${r.title} — ${r.error.slice(0, 200)}`)}`);
  if (failed.length > 9) console.log(`::error title=More failures::${failed.length - 9} more — see the daily-summary artifact`);
  for (const j of jobProblem) console.log(`::warning title=Job not green::${j.name}: ${j.result}`);
  // A notice, not an error: differences are for review, not failures.
  if (differences.length) {
    const shownD = differences.slice(0, 6).map((d) => `${d.env}: ${d.text}`).join(' · ');
    console.log(`::notice title=Differences to review (${differences.length}) — not failures::${oneLine(shownD + (differences.length > 6 ? ` · … ${differences.length - 6} more in the report` : ''))}`);
  }
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'daily-summary.html'), html);
writeFileSync(join(OUT, 'summary.md'), md);
console.log(`📄 ${join(OUT, 'daily-summary.html')}\n${subject}`);

// ── email ──────────────────────────────────────────────────────────────
if (!process.env.SMTP_HOST || !process.env.ALERT_EMAIL_TO) {
  console.log('✉️  SMTP_HOST / ALERT_EMAIL_TO not set — email skipped (report still saved).');
} else {
  const port = Number(process.env.SMTP_PORT || 587);
  const to = process.env.ALERT_EMAIL_TO;
  const from = process.env.ALERT_EMAIL_FROM || process.env.SMTP_USER || to;
  const attachments = [{ filename: `sphere-daily-summary-${RUN_NUMBER || 'run'}.html`, content: html, contentType: 'text/html' }];
  for (const pdf of cmpPdfs) if (statSync(pdf).size < 8 * 1024 * 1024) attachments.push({ filename: basename(pdf), path: pdf });
  try {
    const nodemailer = (await import('nodemailer')).default;
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port, secure: port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
    await transporter.sendMail({ from, to, subject, html, text: md, attachments });
    console.log(`📧 Report emailed to ${to}`);
  } catch (err) {
    // A mail problem must not hide the report — it is still uploaded as an artifact.
    console.error(`⚠️  Email failed: ${err.message}`);
    process.exitCode = 1;
  }
}
