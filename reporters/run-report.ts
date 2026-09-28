/**
 * Client-shareable run report — HTML + PDF, produced on EVERY run.
 * ──────────────────────────────────────────────────────────────────
 * The branded reporter gives a one-line-per-test summary; this one is the
 * full record, so a run can be handed to a client offline with nothing left
 * out:
 *
 *   • every test, with status / duration / file:line / retry
 *   • EVERY step, nested exactly as Playwright recorded it (hooks included),
 *     each with its own duration and error
 *   • the complete console output (stdout + stderr) of each test
 *   • the full error message and stack for failures
 *   • failure screenshots embedded as data URIs (self-contained file)
 *
 * Output (both always written):
 *   test-reports/run-reports/RunReport_<label>_<timestamp>.html
 *   test-reports/run-reports/RunReport_<label>_<timestamp>.pdf
 *   test-reports/run-reports/latest.html · latest.pdf
 *
 * Styling follows the Tarento brand (80/15/5 navy/teal/gold). No logo.
 *
 * Env:
 *   PDF_REPORT=0     skip the PDF (HTML only) — useful on machines with no browser
 *   REPORT_LABEL=…   name used in the file name + heading
 */
import * as fs from 'fs';
import * as path from 'path';
import type {
  Reporter, TestCase, TestResult, TestStep, FullResult, Suite, FullConfig,
} from '@playwright/test/reporter';
import { redact } from './redact';
import { resetObservations } from '../tests/helpers/org-observed';
import { resetRoleRows } from '../tests/helpers/role-report';

// ── brand ──────────────────────────────────────────────────────────
const NAVY = '#0B2545';
const TEAL = '#1B9AAA';
const GOLD = '#E8B02B';
const INK = '#1F2933';
const MUTED = '#7C8696';

type Status = 'Pass' | 'Fail' | 'Timed Out' | 'Skipped' | 'Flaky';

interface StepRow {
  depth: number;
  title: string;
  category: string;
  duration: number;
  error?: string;
}

interface TestRow {
  id: string;
  project: string;
  file: string;
  line: number;
  suite: string;
  title: string;
  status: Status;
  duration: number;
  retry: number;
  steps: StepRow[];
  stdout: string;
  stderr: string;
  errorMessage: string;
  errorStack: string;
  /** Embedded images: attachments carry either a file path or an in-memory body. */
  screenshots: { name: string; b64: string }[];
}

function esc(s: string): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** ESC[<n>m colour codes Playwright embeds in messages. */
const ANSI = new RegExp(String.fromCharCode(27) + '\\[\\d+m', 'g');

/**
 * Strip ANSI colour codes, then mask credentials — these reports get shared
 * with clients, and Playwright records the literal value of every fill().
 */
function plain(s: string): string {
  return redact((s ?? '').replace(ANSI, ''));
}

function ms(d: number): string {
  if (d < 1000) return `${Math.round(d)}ms`;
  if (d < 60_000) return `${(d / 1000).toFixed(1)}s`;
  const m = Math.floor(d / 60_000);
  return `${m}m ${Math.round((d % 60_000) / 1000)}s`;
}

const STATUS_COLOR: Record<Status, string> = {
  Pass: '#1E8E5A',
  Fail: '#C0392B',
  'Timed Out': '#B9770E',
  Skipped: MUTED,
  Flaky: '#B9770E',
};

class RunReportReporter implements Reporter {
  private rows: TestRow[] = [];
  private startTime = new Date();
  private specFiles = new Set<string>();

  onBegin(_config: FullConfig, suite: Suite) {
    this.startTime = new Date();
    // Start each run with an empty org-content observation log.
    resetObservations();
    resetRoleRows();
    for (const t of suite.allTests()) {
      this.specFiles.add(path.basename(t.location.file).replace(/\.spec\.ts$/, ''));
    }
  }

  /** Flatten Playwright's step tree, keeping the nesting depth. */
  private flattenSteps(steps: TestStep[], depth = 0, out: StepRow[] = []): StepRow[] {
    for (const s of steps) {
      out.push({
        depth,
        title: plain(s.title),
        category: s.category,
        duration: s.duration,
        error: s.error ? plain(s.error.message ?? '').split('\n')[0].slice(0, 300) : undefined,
      });
      if (s.steps?.length) this.flattenSteps(s.steps, depth + 1, out);
    }
    return out;
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const parts = test.titlePath().slice(2); // drop [project, file]
    const status: Status =
      result.status === 'passed' ? (result.retry > 0 ? 'Flaky' : 'Pass')
        : result.status === 'failed' ? 'Fail'
        : result.status === 'timedOut' ? 'Timed Out'
        : result.status === 'skipped' ? 'Skipped'
        : 'Fail';

    const text = (chunks: (string | Buffer)[]) =>
      chunks.map((c) => (typeof c === 'string' ? c : c.toString('utf-8'))).join('');

    this.rows.push({
      id: `TC-${String(this.rows.length + 1).padStart(3, '0')}`,
      project: test.parent.project()?.name ?? '',
      file: path.basename(test.location.file),
      line: test.location.line,
      suite: parts.slice(0, -1).join(' › ') || '(root)',
      title: parts[parts.length - 1] ?? test.title,
      status,
      duration: result.duration,
      retry: result.retry,
      steps: this.flattenSteps(result.steps ?? []),
      stdout: plain(text(result.stdout ?? [])),
      stderr: plain(text(result.stderr ?? [])),
      errorMessage: plain(result.error?.message ?? ''),
      errorStack: plain(result.error?.stack ?? ''),
      // Both forms count: Playwright's own capture (a path) and testInfo.attach
      // with a body (labelled shots the specs take deliberately).
      screenshots: (result.attachments ?? [])
        .filter((a) => a.contentType?.startsWith('image/'))
        .map((a) => ({
          name: a.name || 'screenshot',
          b64: a.body
            ? a.body.toString('base64')
            : (a.path && fs.existsSync(a.path) ? fs.readFileSync(a.path).toString('base64') : ''),
        }))
        .filter((x) => x.b64),
    });
  }

  async onEnd(_result: FullResult) {
    if (!this.rows.length) return;

    const label =
      process.env.REPORT_LABEL ||
      (this.specFiles.size === 1 ? [...this.specFiles][0] : 'FullRun');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = path.resolve(process.cwd(), 'test-reports', 'run-reports');
    fs.mkdirSync(dir, { recursive: true });

    const htmlPath = path.join(dir, `RunReport_${label}_${stamp}.html`);
    const pdfPath = path.join(dir, `RunReport_${label}_${stamp}.pdf`);

    const html = this.render(label);
    fs.writeFileSync(htmlPath, html, 'utf-8');
    fs.writeFileSync(path.join(dir, 'latest.html'), html, 'utf-8');
    console.log(`\n📘 Run report (all steps): ${htmlPath}`);

    if (process.env.PDF_REPORT === '0') return;
    try {
      await this.toPdf(htmlPath, pdfPath, label);
      fs.copyFileSync(pdfPath, path.join(dir, 'latest.pdf'));
      console.log(`📕 Shareable PDF:          ${pdfPath}`);
    } catch (e) {
      console.log(`⚠️  PDF not generated (${(e as Error).message.split('\n')[0]}). The HTML above has the same content.`);
    }
  }

  /** Print the HTML to A4 PDF with Chromium. */
  private async toPdf(htmlFile: string, pdfFile: string, label: string) {
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`file://${htmlFile.replace(/\\/g, '/')}`, { waitUntil: 'load' });
      await page.emulateMedia({ media: 'print' });
      await page.waitForTimeout(600);
      await page.pdf({
        path: pdfFile,
        format: 'A4',
        printBackground: true,
        margin: { top: '12mm', bottom: '14mm', left: '10mm', right: '10mm' },
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate:
          `<div style="width:100%;font-family:Arial,sans-serif;font-size:8pt;color:${MUTED};padding:0 12mm;">` +
          `<span style="float:left;">e-kshamata Web Automation — ${esc(label)}</span>` +
          `<span style="float:right;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>` +
          `</div>`,
      });
    } finally {
      await browser.close();
    }
  }

  // ── rendering ────────────────────────────────────────────────────
  private renderSteps(row: TestRow): string {
    if (!row.steps.length) return `<p class="none">No steps recorded.</p>`;
    const items = row.steps
      .map((s) => {
        const indent = 10 + s.depth * 16;
        const err = s.error ? `<div class="step-err">${esc(s.error)}</div>` : '';
        return (
          `<li class="step${s.error ? ' step-failed' : ''}" style="padding-left:${indent}px">` +
          `<span class="step-cat">${esc(s.category)}</span>` +
          `<span class="step-title">${esc(s.title)}</span>` +
          `<span class="step-dur">${ms(s.duration)}</span>${err}</li>`
        );
      })
      .join('');
    return `<ol class="steps">${items}</ol>`;
  }

  private renderShots(row: TestRow): string {
    const shots = row.screenshots.slice(0, 6).map((s) =>
      `<figure><img src="data:image/png;base64,${s.b64}" alt="${esc(s.name)}"/>` +
      `<figcaption>${esc(s.name)}</figcaption></figure>`).join('');
    return shots ? `<div class="shots">${shots}</div>` : '';
  }

  private render(label: string): string {
    const total = this.rows.length;
    const pass = this.rows.filter((r) => r.status === 'Pass').length;
    const fail = this.rows.filter((r) => r.status === 'Fail' || r.status === 'Timed Out').length;
    const skip = this.rows.filter((r) => r.status === 'Skipped').length;
    const flaky = this.rows.filter((r) => r.status === 'Flaky').length;
    const rate = total ? ((pass / total) * 100).toFixed(1) : '0.0';
    const durationS = ((Date.now() - this.startTime.getTime()) / 1000).toFixed(1);
    const env = process.env.BASE_URL ?? 'https://sphere.aastrika.org';
    const totalSteps = this.rows.reduce((n, r) => n + r.steps.length, 0);

    const toc = this.rows
      .map((r) =>
        `<tr><td>${r.id}</td><td>${esc(r.title)}</td><td>${esc(r.file)}:${r.line}</td>` +
        `<td><span class="chip" style="background:${STATUS_COLOR[r.status]}">${r.status}</span></td>` +
        `<td class="num">${ms(r.duration)}</td><td class="num">${r.steps.length}</td></tr>`)
      .join('');

    const details = this.rows
      .map((r) => {
        const err = r.errorMessage
          ? `<div class="block err"><h4>Error</h4><pre>${esc(r.errorMessage)}</pre>` +
            (r.errorStack ? `<details><summary>Stack trace</summary><pre>${esc(r.errorStack)}</pre></details>` : '') +
            `</div>`
          : '';
        const out = r.stdout.trim()
          ? `<div class="block"><h4>Console output</h4><pre>${esc(r.stdout.trim())}</pre></div>` : '';
        const errOut = r.stderr.trim()
          ? `<div class="block"><h4>stderr</h4><pre>${esc(r.stderr.trim())}</pre></div>` : '';
        return (
          `<section class="test">` +
          `<h3><span class="chip" style="background:${STATUS_COLOR[r.status]}">${r.status}</span> ` +
          `${r.id} · ${esc(r.title)}</h3>` +
          `<p class="meta">${esc(r.suite)} — ${esc(r.file)}:${r.line}` +
          `${r.project ? ` · project ${esc(r.project)}` : ''} · ${ms(r.duration)}` +
          `${r.retry ? ` · retry ${r.retry}` : ''} · ${r.steps.length} steps</p>` +
          err +
          `<div class="block"><h4>All steps (${r.steps.length})</h4>${this.renderSteps(r)}</div>` +
          out + errOut + this.renderShots(r) +
          `</section>`
        );
      })
      .join('');

    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>e-kshamata Automation — Run Report — ${esc(label)}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:'Open Sans',Segoe UI,Arial,sans-serif;color:${INK};background:#fff;font-size:12px;line-height:1.5}
  .wrap{max-width:1100px;margin:0 auto;padding:24px}
  header{background:${NAVY};color:#fff;padding:22px 24px;border-radius:6px}
  header h1{margin:0 0 4px;font-size:20px;font-weight:600}
  header p{margin:2px 0;color:#C7D2E0;font-size:11px}
  .cards{display:flex;gap:10px;margin:18px 0 8px;flex-wrap:wrap}
  .card{flex:1;min-width:110px;border:1px solid #E3E8EF;border-top:3px solid ${TEAL};border-radius:5px;padding:10px 12px}
  .card .k{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:${MUTED}}
  .card .v{font-size:20px;font-weight:600;color:${NAVY}}
  h2{color:${NAVY};font-size:15px;margin:22px 0 8px;border-bottom:2px solid ${GOLD};padding-bottom:4px}
  table{width:100%;border-collapse:collapse;font-size:11px}
  th{background:${NAVY};color:#fff;text-align:left;padding:6px 8px;font-weight:600}
  td{border-bottom:1px solid #E9EDF2;padding:5px 8px;vertical-align:top}
  td.num{text-align:right;white-space:nowrap}
  .chip{color:#fff;border-radius:9px;padding:1px 8px;font-size:10px;font-weight:600;display:inline-block}
  .test{border:1px solid #E3E8EF;border-radius:6px;padding:12px 14px;margin:12px 0;page-break-inside:avoid}
  .test h3{margin:0 0 4px;font-size:13px;color:${NAVY}}
  .meta{margin:0 0 8px;color:${MUTED};font-size:10.5px}
  .block{margin-top:10px}
  .block h4{margin:0 0 5px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:${TEAL}}
  .err pre{background:#FDF3F2;border-left:3px solid #C0392B}
  pre{background:#F6F8FA;border-left:3px solid ${TEAL};padding:8px 10px;margin:0;font-family:Consolas,monospace;
      font-size:10px;white-space:pre-wrap;word-break:break-word;max-height:none}
  details summary{cursor:pointer;color:${MUTED};font-size:10.5px;margin-top:4px}
  ol.steps{list-style:none;margin:0;padding:0;border:1px solid #EDF1F5;border-radius:4px}
  li.step{display:block;padding:3px 8px;border-bottom:1px solid #F2F5F8;font-size:10.5px}
  li.step:last-child{border-bottom:0}
  li.step-failed{background:#FDF3F2}
  .step-cat{display:inline-block;min-width:64px;color:${MUTED};font-size:9.5px;text-transform:uppercase}
  .step-title{color:${INK}}
  .step-dur{float:right;color:${MUTED};font-variant-numeric:tabular-nums}
  .step-err{color:#C0392B;font-size:10px;margin:2px 0 2px 64px}
  .shots{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px}
  .shots figure{margin:0;max-width:48%}
  .shots img{width:100%;border:1px solid #E3E8EF;border-radius:4px}
  .shots figcaption{color:${MUTED};font-size:9.5px;margin-top:3px}
  .none{color:${MUTED};font-style:italic;margin:0}
  footer{margin-top:26px;color:${MUTED};font-size:10px;border-top:1px solid #E9EDF2;padding-top:10px}
  @media print{ .wrap{max-width:none;padding:0} .test{break-inside:avoid} header{border-radius:0} }
</style></head>
<body><div class="wrap">
<header>
  <h1>e-kshamata Web Automation — Run Report</h1>
  <p>${esc(label)} · ${this.startTime.toLocaleString()}</p>
  <p>Environment: ${esc(env)}</p>
</header>

<div class="cards">
  <div class="card"><div class="k">Tests</div><div class="v">${total}</div></div>
  <div class="card"><div class="k">Passed</div><div class="v">${pass}</div></div>
  <div class="card"><div class="k">Failed</div><div class="v">${fail}</div></div>
  <div class="card"><div class="k">Skipped</div><div class="v">${skip}</div></div>
  ${flaky ? `<div class="card"><div class="k">Flaky</div><div class="v">${flaky}</div></div>` : ''}
  <div class="card"><div class="k">Pass rate</div><div class="v">${rate}%</div></div>
  <div class="card"><div class="k">Duration</div><div class="v">${durationS}s</div></div>
  <div class="card"><div class="k">Steps</div><div class="v">${totalSteps}</div></div>
</div>

<h2>Summary</h2>
<table><thead><tr><th>ID</th><th>Test</th><th>Location</th><th>Status</th><th>Duration</th><th>Steps</th></tr></thead>
<tbody>${toc}</tbody></table>

<h2>Detailed results — every step, every log line</h2>
${details}

<footer>Generated automatically by the Playwright run-report reporter. Steps, console output and errors are
reproduced in full, exactly as recorded during the run.</footer>
</div></body></html>`;
  }
}

export default RunReportReporter;
