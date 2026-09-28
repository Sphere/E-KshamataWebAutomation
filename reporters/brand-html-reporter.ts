/**
 * Branded HTML Test Reporter for Playwright (Ekshamata web suite).
 * ──────────────────────────────────────────────────────────────────
 * Runs on EVERY `playwright test` invocation and writes a self-contained,
 * brand-styled HTML report listing every test case:
 *
 *   brand-reports/report[_<label>]_<timestamp>.html   (per run, timestamped)
 *   brand-reports/latest.html                          (always the newest)
 *
 * Palette: navy / teal / gold (80/15/5). No logo.
 *
 * Wired in playwright.config.ts:
 *   reporter: [['list'], ['./reporters/brand-html-reporter.ts'], ...]
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Reporter, TestCase, TestResult, FullResult, Suite, FullConfig, TestStep } from '@playwright/test/reporter';

interface StepRow {
  title: string;
  ok: boolean;
  duration: string;
  error: string;
}

interface Row {
  id: string;
  project: string;
  file: string;
  suite: string;
  title: string;
  status: 'Pass' | 'Fail' | 'Skipped' | 'Timed Out' | 'Flaky';
  duration: string;
  error: string;
  steps: StepRow[];
}

/** Flatten every `test.step()` (each click/action) into an ordered list. */
function collectSteps(arr: readonly TestStep[] | undefined, out: StepRow[]): void {
  for (const s of arr ?? []) {
    if (s.category === 'test.step') {
      out.push({
        title: s.title,
        ok: !s.error,
        duration: (s.duration / 1000).toFixed(2),
        error: (s.error?.message ?? '').replace(/\[\d+m/g, '').replace(/\s+/g, ' ').trim().slice(0, 300),
      });
    }
    if (s.steps?.length) collectSteps(s.steps, out);
  }
}

const STATUS_CLASS: Record<Row['status'], string> = {
  Pass: 'pass',
  Fail: 'fail',
  Skipped: 'skip',
  'Timed Out': 'warn',
  Flaky: 'warn',
};

function esc(s: string): string {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

class BrandHtmlReporter implements Reporter {
  private rows: Row[] = [];
  private startTime = new Date();
  private specFiles = new Set<string>();
  private runLabel = '';

  onBegin(_config: FullConfig, suite: Suite) {
    this.startTime = new Date();
    for (const t of suite.allTests()) {
      this.specFiles.add(path.basename(t.location.file).replace(/\.spec\.ts$/, ''));
    }
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const titles = test.titlePath();       // [project, file, ...describes, title]
    const project = titles[0] || '';
    const parts = titles.slice(2);
    const suite = parts.slice(0, -1).join(' › ') || '(root)';
    const title = parts[parts.length - 1] ?? test.title;
    const file = path.basename(test.location.file).replace(/\.spec\.ts$/, '');

    let status: Row['status'];
    switch (result.status) {
      case 'passed': status = 'Pass'; break;
      case 'failed': status = 'Fail'; break;
      case 'timedOut': status = 'Timed Out'; break;
      case 'skipped': status = 'Skipped'; break;
      default: status = 'Fail';
    }
    const error = (result.error?.message ?? '')
      .replace(/\[\d+m/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 600);

    const steps: StepRow[] = [];
    collectSteps(result.steps, steps);

    this.rows.push({
      id: `TC-${String(this.rows.length + 1).padStart(3, '0')}`,
      project,
      file,
      suite,
      title,
      status,
      duration: (result.duration / 1000).toFixed(2),
      error,
      steps,
    });
  }

  async onEnd(result: FullResult) {
    const pass = this.rows.filter((r) => r.status === 'Pass').length;
    const fail = this.rows.filter((r) => r.status === 'Fail' || r.status === 'Timed Out').length;
    const skip = this.rows.filter((r) => r.status === 'Skipped').length;
    const total = this.rows.length;
    const rate = total ? ((pass / total) * 100).toFixed(1) : '0.0';
    const env = process.env.BASE_URL ?? 'https://ekshamata.aastrika.org';
    const durationS = ((Date.now() - this.startTime.getTime()) / 1000).toFixed(1);

    this.runLabel =
      process.env.REPORT_LABEL ||
      (this.specFiles.size === 1 ? [...this.specFiles][0] : '');

    const html = this.render({ result, pass, fail, skip, total, rate, env, durationS });

    const dir = path.resolve(process.cwd(), 'brand-reports');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ts = this.startTime.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const labelPart = this.runLabel ? `_${this.runLabel}` : '';
    const file = path.join(dir, `report${labelPart}_${ts}.html`);
    fs.writeFileSync(file, html, 'utf-8');
    fs.writeFileSync(path.join(dir, 'latest.html'), html, 'utf-8');
    console.log(`\n🎨 Branded report saved: ${file}`);
  }

  private render(d: {
    result: FullResult; pass: number; fail: number; skip: number;
    total: number; rate: string; env: string; durationS: string;
  }): string {
    const overall = d.result.status.toUpperCase();
    const overallClass = d.fail > 0 ? 'fail' : 'pass';

    const rowsHtml = this.rows
      .map((r) => {
        const main = `
        <tr class="testrow">
          <td class="tc">${r.id}</td>
          <td class="center"><span class="proj">${esc(r.project)}</span></td>
          <td class="suite">${esc(r.file)}</td>
          <td><strong>${esc(r.title)}</strong>${r.steps.length ? ` <span class="stepcount">${r.steps.length} steps</span>` : ''}</td>
          <td class="center"><span class="badge ${STATUS_CLASS[r.status]}">${r.status}</span></td>
          <td class="center num">${r.duration}s</td>
          <td class="err">${esc(r.error)}</td>
        </tr>`;
        const steps = r.steps
          .map(
            (s, i) => `
        <tr class="steprow">
          <td class="tc sub">${r.id}.${i + 1}</td>
          <td class="center"><span class="steptag">step</span></td>
          <td class="suite"></td>
          <td class="step">↳ ${esc(s.title)}</td>
          <td class="center"><span class="badge ${s.ok ? 'pass' : 'fail'}">${s.ok ? 'Pass' : 'Fail'}</span></td>
          <td class="center num">${s.duration}s</td>
          <td class="err">${esc(s.error)}</td>
        </tr>`,
          )
          .join('');
        return main + steps;
      })
      .join('');

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Ekshamata Automation — Test Report</title>
<style>
  :root{
    --navy:#17283C; --teal:#1E8F8E; --teal-50:#E3F7F6;
    --gold:#F0A500; --gold-50:#FEF6E0; --gold-700:#9A6800;
    --off-white:#F6F7F9; --light-gray:#D8DEE5; --mid-gray:#7C8696; --almost-black:#0D1218;
    --success:#15803D; --success-lt:#DCFCE7; --error:#B91C1C; --error-lt:#FEE2E2;
    --warning:#B45309; --warning-lt:#FEF3C7;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--off-white);color:var(--almost-black);
    font-family:'Segoe UI',system-ui,-apple-system,Roboto,sans-serif;font-size:14px;line-height:1.6}
  .wrap{max-width:1280px;margin:0 auto;padding:24px}
  header{background:var(--navy);color:#fff;border-radius:8px 8px 0 0;padding:24px;border-bottom:4px solid var(--teal)}
  header h1{margin:0;font-size:24px;font-weight:700}
  header .meta{margin-top:4px;color:#BEC5CE;font-size:13px}
  header .envs{margin-top:12px;font-size:12px;color:#BEC5CE}
  header .envs code{color:#fff;background:rgba(255,255,255,.08);padding:1px 6px;border-radius:4px}
  .cards{display:grid;grid-template-columns:repeat(5,1fr);gap:16px;background:#fff;padding:24px;
    border-left:1px solid var(--light-gray);border-right:1px solid var(--light-gray)}
  .card{border:1px solid var(--light-gray);border-radius:8px;padding:16px;text-align:center;background:#fff}
  .card .n{font-size:28px;font-weight:700;color:var(--navy)}
  .card .l{font-size:12px;font-weight:600;color:var(--mid-gray);text-transform:uppercase;letter-spacing:.04em}
  .card.pass .n{color:var(--success)} .card.fail .n{color:var(--error)} .card.skip .n{color:var(--mid-gray)}
  .card.kpi{background:var(--gold-50);border-color:var(--gold)}
  .card.kpi .n{color:var(--gold-700)}
  table{width:100%;border-collapse:collapse;background:#fff;
    border:1px solid var(--light-gray);border-radius:0 0 8px 8px;overflow:hidden}
  thead th{background:var(--navy);color:#fff;text-align:left;font-weight:600;font-size:13px;padding:12px}
  thead th.center{text-align:center}
  tbody td{padding:10px 12px;border-top:1px solid var(--light-gray);vertical-align:top}
  tbody tr:nth-child(even){background:var(--off-white)}
  td.center{text-align:center} td.num{font-variant-numeric:tabular-nums}
  td.tc{font-weight:700;color:var(--navy);white-space:nowrap}
  td.suite{color:var(--mid-gray)}
  td.err{color:var(--error);font-size:12px;max-width:360px}
  .proj{display:inline-block;padding:1px 8px;border-radius:9999px;font-size:11px;font-weight:600;background:var(--teal-50);color:var(--navy)}
  tr.testrow td{border-top:2px solid var(--light-gray)}
  tr.steprow td{background:#FBFCFD;padding:6px 12px}
  tr.steprow:nth-child(even) td{background:#FBFCFD}
  td.tc.sub{font-weight:600;color:var(--mid-gray);font-size:12px}
  td.step{color:var(--almost-black)}
  .steptag{display:inline-block;padding:0 7px;border-radius:9999px;font-size:10px;font-weight:600;background:var(--off-white);color:var(--mid-gray);border:1px solid var(--light-gray)}
  .stepcount{display:inline-block;margin-left:8px;padding:0 7px;border-radius:9999px;font-size:11px;font-weight:600;background:var(--teal-50);color:var(--teal-600,#186E6E)}
  .badge{display:inline-block;padding:2px 10px;border-radius:9999px;font-size:12px;font-weight:600}
  .badge.pass{background:var(--success-lt);color:var(--success)}
  .badge.fail{background:var(--error-lt);color:var(--error)}
  .badge.skip{background:var(--off-white);color:var(--mid-gray);border:1px solid var(--light-gray)}
  .badge.warn{background:var(--warning-lt);color:var(--warning)}
  .bar{height:8px;background:var(--light-gray);border-radius:9999px;overflow:hidden;margin:16px 0 0}
  .bar > i{display:block;height:100%;background:var(--teal)}
  footer{color:var(--mid-gray);font-size:12px;padding:16px 4px;text-align:center}
  .pill{display:inline-block;padding:2px 10px;border-radius:9999px;font-weight:600;font-size:12px}
  .pill.pass{background:var(--success-lt);color:var(--success)}
  .pill.fail{background:var(--error-lt);color:var(--error)}
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>Ekshamata Automation — ${this.runLabel ? esc(this.runLabel[0].toUpperCase() + this.runLabel.slice(1)) + ' ' : ''}Test Report</h1>
      <div class="meta">
        ${esc(this.startTime.toLocaleString())} · Overall: <span class="pill ${overallClass}">${overall}</span>
      </div>
      <div class="envs">Environment: <code>${esc(d.env)}</code> · ${d.total} test case${d.total === 1 ? '' : 's'}</div>
    </header>

    <div class="cards">
      <div class="card"><div class="n">${d.total}</div><div class="l">Total</div></div>
      <div class="card pass"><div class="n">${d.pass}</div><div class="l">Passed</div></div>
      <div class="card fail"><div class="n">${d.fail}</div><div class="l">Failed</div></div>
      <div class="card skip"><div class="n">${d.skip}</div><div class="l">Skipped</div></div>
      <div class="card kpi"><div class="n">${d.rate}%</div><div class="l">Pass Rate</div></div>
    </div>

    <div style="background:#fff;padding:0 24px 16px;border-left:1px solid var(--light-gray);border-right:1px solid var(--light-gray)">
      <div class="bar"><i style="width:${d.rate}%"></i></div>
    </div>

    <table>
      <thead>
        <tr>
          <th>TC</th><th class="center">Project</th><th>Spec</th><th>Test case</th>
          <th class="center">Status</th><th class="center">Duration</th><th>Error</th>
        </tr>
      </thead>
      <tbody>${rowsHtml || '<tr><td colspan="7" class="center">No tests ran</td></tr>'}</tbody>
    </table>

    <footer>Duration ${d.durationS}s · Generated by the Ekshamata automation suite</footer>
  </div>
</body>
</html>`;
  }
}

export default BrandHtmlReporter;
