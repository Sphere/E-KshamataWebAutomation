/**
 * Excel Test Reporter for Playwright
 * ──────────────────────────────────────────────────────────────────
 * Generates an Excel file with detailed test results after every run.
 * Writes to: test-reports/TestReport_<spec-name>_<timestamp>.xlsx
 *
 * Columns:
 *   TC ID | Suite | Test Case | Description | Expected | Actual |
 *   Status | Duration (s) | Run At | Error
 *
 * Usage in playwright.config.ts:
 *   reporter: [['list'], ['./reporters/excel-reporter.ts']]
 */

import * as fs from 'fs';
import * as path from 'path';
// exceljs is heavy — import it lazily in onEnd (below) so it doesn't slow every
// `playwright test` startup / browser launch.
import type {
  Reporter, TestCase, TestResult, TestStep, FullResult, Suite, FullConfig,
} from '@playwright/test/reporter';
import { redact } from './redact';

interface StepRow {
  title: string;                 // "↳ Level 1: ..." (indented for nested steps)
  status: 'Pass' | 'Fail';
  duration: string;
}

/** One row per Playwright step (ALL categories), so the workbook carries the
 *  complete execution trail — not just the test.step() milestones. */
interface FullStepRow {
  testId: string;
  test: string;
  n: number;
  depth: number;
  category: string;
  step: string;
  duration: string;
  error: string;
}

/** Captured console output, one row per test per stream. */
interface LogRow {
  testId: string;
  test: string;
  stream: 'stdout' | 'stderr';
  output: string;
}

interface TestRow {
  id: string;
  suite: string;
  title: string;
  description: string;
  expected: string;
  actual: string;
  status: 'Pass' | 'Fail' | 'Skipped' | 'Timed Out' | 'Flaky';
  duration: string;
  runAt: string;
  error: string;
  steps: StepRow[];
}

/** Flatten every `test.step()` (each level / module action) into an ordered list. */
function collectSteps(steps: TestStep[], out: StepRow[], depth = 0): void {
  for (const s of steps) {
    if (s.category === 'test.step') {
      out.push({
        title: `↳ ${'   '.repeat(depth)}${s.title}`,
        status: s.error ? 'Fail' : 'Pass',
        duration: (s.duration / 1000).toFixed(2),
      });
      if (s.steps?.length) collectSteps(s.steps, out, depth + 1);
    } else if (s.steps?.length) {
      collectSteps(s.steps, out, depth);
    }
  }
}

class ExcelReporter implements Reporter {
  private fullSteps: FullStepRow[] = [];
  private logRows: LogRow[] = [];

  /** Walk the whole step tree depth-first, preserving order and nesting. */
  private collectAllSteps(steps: TestStep[], testId: string, test: string, depth = 0) {
    for (const s of steps) {
      this.fullSteps.push({
        testId,
        test,
        n: this.fullSteps.length + 1,
        depth,
        category: s.category,
        // redact(): Playwright records the literal fill() value, so a password
        // would otherwise sit in plain sight in a shared workbook.
        step: redact(s.title ?? ''),
        duration: `${(s.duration / 1000).toFixed(2)}s`,
        error: s.error ? redact(s.error.message ?? '').split('\n')[0].slice(0, 300) : '',
      });
      if (s.steps?.length) this.collectAllSteps(s.steps, testId, test, depth + 1);
    }
  }

  private rows: TestRow[] = [];
  private startTime = new Date();
  private specFiles = new Set<string>();

  onBegin(_config: FullConfig, suite: Suite) {
    this.startTime = new Date();
    for (const t of suite.allTests()) {
      this.specFiles.add(path.basename(t.location.file).replace(/\.spec\.ts$/, ''));
    }
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const titles = test.titlePath();   // [project, file, ...describes, test title]
    // titles[0] = project, titles[1] = file — drop both
    const path_parts = titles.slice(2);
    const suite = path_parts.slice(0, -1).join(' › ') || '(root)';
    const title = path_parts[path_parts.length - 1] ?? test.title;

    // Map status
    let status: TestRow['status'];
    switch (result.status) {
      case 'passed':    status = 'Pass';      break;
      case 'failed':    status = 'Fail';      break;
      case 'timedOut':  status = 'Timed Out'; break;
      case 'skipped':   status = 'Skipped';   break;
      default:          status = 'Fail';
    }

    // Look for an "account-info" attachment — tests use testInfo.attach() to
    // attach details like the email created and role assigned. This shows up
    // in the Actual column so the report shows what the test actually produced.
    let attachedInfo = '';
    for (const att of result.attachments ?? []) {
      if (att.name === 'account-info' && att.body) {
        try {
          attachedInfo = att.body.toString('utf-8');
        } catch { /* ignore */ }
      }
    }

    // Description = derive from test title (it's already descriptive)
    // Append the attached info if present (e.g., "Email: foo@bar | Role: ...")
    const description = attachedInfo
      ? `${title} — ${attachedInfo}`
      : title;

    // Expected = positive outcome derived from the test title
    const expected = this.deriveExpected(title);

    // Actual = based on status, with the attached info appended on Pass
    const actual = status === 'Pass'
      ? (attachedInfo ? `Pass — ${attachedInfo}` : `Matches expected — ${expected}`)
      : `${status}${result.error ? ': ' + this.shortenError(result.error.message ?? '') : ''}`;

    // Error details
    const error = result.error
      ? this.shortenError(result.error.message ?? '', 800)
      : '';

    const steps: StepRow[] = [];
    collectSteps(result.steps, steps);

    this.rows.push({
      id: `TC-${String(this.rows.length + 1).padStart(3, '0')}`,
      suite,
      title,
      description,
      expected,
      actual,
      status,
      duration: (result.duration / 1000).toFixed(2),
      runAt: new Date().toLocaleTimeString(),
      error,
      steps,
    });

    // Full execution trail for this test: every step, then its console output.
    const testId = `TC-${String(this.rows.length).padStart(3, '0')}`;
    this.collectAllSteps(result.steps ?? [], testId, title);
    const join = (chunks: (string | Buffer)[]) =>
      redact(chunks.map((c) => (typeof c === 'string' ? c : c.toString('utf-8'))).join('')).trim();
    const out = join(result.stdout ?? []);
    const errOut = join(result.stderr ?? []);
    if (out) this.logRows.push({ testId, test: title, stream: 'stdout', output: out });
    if (errOut) this.logRows.push({ testId, test: title, stream: 'stderr', output: errOut });
  }

  async onEnd(result: FullResult) {
    await this.writeExcel(result);
  }

  // ─── Helpers ──────────────────────────────────────────────────────
  private deriveExpected(title: string): string {
    // Most assertion-style titles already describe the expected state.
    // Examples that get cleaned up:
    //   "Logo is visible" → "Logo is visible"
    //   "Next button disabled before any language is selected" → same
    // Tweak common patterns to be a touch more formal.
    return title
      .replace(/^check that\s+/i, '')
      .replace(/^verify that\s+/i, '')
      .replace(/^test that\s+/i, '');
  }

  private shortenError(err: string, max = 400): string {
    const cleaned = err
      .replace(/\u001b\[\d+m/g, '')          // strip ANSI color codes
      .replace(/\n+/g, ' | ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned.length > max ? cleaned.slice(0, max) + '…' : cleaned;
  }

  private async writeExcel(result: FullResult) {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Ekshamata Automation Suite';
    workbook.created = this.startTime;

    // ─── Sheet 1: Test Results ────────────────────────────────────
    const sheet = workbook.addWorksheet('Test Results', {
      views: [{ state: 'frozen', xSplit: 0, ySplit: 3 }],
    });

    // Title row
    sheet.mergeCells('A1:J1');
    const titleCell = sheet.getCell('A1');
    titleCell.value = `Ekshamata Automation Test Report — ${this.startTime.toLocaleString()}`;
    titleCell.font = { name: 'Open Sans', size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17283C' } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
    sheet.getRow(1).height = 26;

    // Summary row
    sheet.mergeCells('A2:J2');
    const passCount = this.rows.filter(r => r.status === 'Pass').length;
    const failCount = this.rows.filter(r => r.status === 'Fail').length;
    const skipCount = this.rows.filter(r => r.status === 'Skipped').length;
    const totalDuration = ((Date.now() - this.startTime.getTime()) / 1000).toFixed(1);
    const summaryCell = sheet.getCell('A2');
    summaryCell.value =
      `Total: ${this.rows.length}  |  ` +
      `✓ Pass: ${passCount}  |  ✗ Fail: ${failCount}  |  ⊘ Skipped: ${skipCount}  |  ` +
      `Duration: ${totalDuration}s  |  Overall: ${result.status.toUpperCase()}`;
    summaryCell.font = { name: 'Open Sans', size: 11, italic: true };
    summaryCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3F7F6' } };
    summaryCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    sheet.getRow(2).height = 22;

    // Header row
    const headers = [
      'TC ID', 'Suite', 'Test Case', 'Description', 'Expected Result',
      'Actual Result', 'Status', 'Duration (s)', 'Run At', 'Error Details',
    ];
    sheet.getRow(3).values = headers;
    sheet.getRow(3).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17283C' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = {
        top:    { style: 'thin', color: { argb: 'FFD8DEE5' } },
        left:   { style: 'thin', color: { argb: 'FFD8DEE5' } },
        bottom: { style: 'thin', color: { argb: 'FFD8DEE5' } },
        right:  { style: 'thin', color: { argb: 'FFD8DEE5' } },
      };
    });
    sheet.getRow(3).height = 30;

    // Column widths
    sheet.columns = [
      { key: 'id',         width: 10 },  // TC ID
      { key: 'suite',      width: 35 },  // Suite
      { key: 'title',      width: 50 },  // Test Case
      { key: 'desc',       width: 50 },  // Description
      { key: 'expected',   width: 45 },  // Expected
      { key: 'actual',     width: 45 },  // Actual
      { key: 'status',     width: 12 },  // Status
      { key: 'duration',   width: 12 },  // Duration
      { key: 'runAt',      width: 14 },  // Run At
      { key: 'error',      width: 60 },  // Error
    ];

    // Data rows
    this.rows.forEach((row, i) => {
      const r = sheet.addRow([
        row.id, row.suite, row.title, row.description,
        row.expected, row.actual, row.status,
        row.duration, row.runAt, row.error,
      ]);

      // Body styling
      r.eachCell((cell, colNumber) => {
        cell.alignment = { vertical: 'top', wrapText: true };
        cell.font = { name: 'Open Sans', size: 10 };
        cell.border = {
          top:    { style: 'hair', color: { argb: 'FFD8DEE5' } },
          left:   { style: 'hair', color: { argb: 'FFD8DEE5' } },
          bottom: { style: 'hair', color: { argb: 'FFD8DEE5' } },
          right:  { style: 'hair', color: { argb: 'FFD8DEE5' } },
        };
        // Alternating row background (only on non-status cols)
        if (i % 2 === 0 && colNumber !== 7) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6F7F9' } };
        }
      });

      // TC ID column gets a light teal background
      r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3F7F6' } };
      r.getCell(1).font = { name: 'Open Sans', size: 10, bold: true };
      r.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };

      // Status cell: color-code by result
      const statusCell = r.getCell(7);
      statusCell.alignment = { vertical: 'middle', horizontal: 'center' };
      statusCell.font = { name: 'Open Sans', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
      const statusColors: Record<TestRow['status'], string> = {
        Pass:        'FF15803D',
        Fail:        'FFB91C1C',
        Skipped:     'FF7C8696',
        'Timed Out': 'FFB45309',
        Flaky:       'FFF59E0B',
      };
      statusCell.fill = {
        type: 'pattern', pattern: 'solid',
        fgColor: { argb: statusColors[row.status] ?? 'FF7C8696' },
      };

      // Duration center-aligned
      r.getCell(8).alignment = { vertical: 'middle', horizontal: 'center' };
      r.getCell(9).alignment = { vertical: 'middle', horizontal: 'center' };

      // ── Step sub-rows (each test.step: level / module action) ──
      row.steps.forEach((st) => {
        const sr = sheet.addRow(['', '', st.title, '', '', '', st.status, st.duration, '', '']);
        sr.eachCell((cell) => {
          cell.font = { name: 'Open Sans', size: 9, color: { argb: 'FF556070' } };
          cell.alignment = { vertical: 'top', wrapText: true };
          cell.border = { bottom: { style: 'hair', color: { argb: 'FFECEFF3' } } };
        });
        sr.getCell(3).alignment = { vertical: 'top', wrapText: true, indent: 1 };
        const stCell = sr.getCell(7);
        stCell.alignment = { vertical: 'middle', horizontal: 'center' };
        stCell.font = { name: 'Open Sans', size: 9, bold: true, color: { argb: 'FFFFFFFF' } };
        stCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: st.status === 'Pass' ? 'FF15803D' : 'FFB91C1C' } };
        sr.getCell(8).alignment = { vertical: 'middle', horizontal: 'center' };
      });
    });

    // Auto-filter on headers (covers test rows + their step sub-rows)
    sheet.autoFilter = {
      from: { row: 3, column: 1 },
      to:   { row: sheet.rowCount, column: headers.length },
    };

    // ─── Sheet 2: Summary ─────────────────────────────────────────
    const summary = workbook.addWorksheet('Summary');
    summary.columns = [
      { header: 'Metric', key: 'metric', width: 28 },
      { header: 'Value',  key: 'value',  width: 22 },
    ];
    summary.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17283C' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    summary.getRow(1).height = 28;

    const summaryRows = [
      { metric: 'Test Run Started', value: this.startTime.toLocaleString() },
      { metric: 'Total Tests',      value: this.rows.length },
      { metric: 'Passed',           value: passCount },
      { metric: 'Failed',           value: failCount },
      { metric: 'Skipped',          value: skipCount },
      { metric: 'Pass Rate',        value: this.rows.length
                                          ? `${((passCount / this.rows.length) * 100).toFixed(1)}%`
                                          : '0%' },
      { metric: 'Total Duration',   value: `${totalDuration}s` },
      { metric: 'Overall Result',   value: result.status.toUpperCase() },
      { metric: 'Spec Files',       value: [...this.specFiles].join(', ') },
    ];
    summaryRows.forEach((sr) => {
      const row = summary.addRow(sr);
      row.eachCell((cell) => {
        cell.font = { name: 'Open Sans', size: 11 };
        cell.alignment = { vertical: 'middle' };
        cell.border = { bottom: { style: 'hair', color: { argb: 'FFD8DEE5' } } };
      });
      row.getCell(1).font = { name: 'Open Sans', size: 11, bold: true };

      // Pass Rate = the single headline KPI → the one gold (5%) accent.
      if (sr.metric === 'Pass Rate') {
        row.eachCell((cell) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF6E0' } };
          cell.font = { name: 'Open Sans', size: 11, bold: true, color: { argb: 'FF17283C' } };
        });
      }
    });

    // ─── Sheet 3: Steps — the complete execution trail ────────────
    const stepsSheet = workbook.addWorksheet('Steps');
    stepsSheet.columns = [
      { header: '#',        key: 'n',        width: 6 },
      { header: 'Test ID',  key: 'testId',   width: 10 },
      { header: 'Test',     key: 'test',     width: 40 },
      { header: 'Level',    key: 'depth',    width: 7 },
      { header: 'Category', key: 'category', width: 12 },
      { header: 'Step',     key: 'step',     width: 80 },
      { header: 'Duration', key: 'duration', width: 11 },
      { header: 'Error',    key: 'error',    width: 60 },
    ];
    stepsSheet.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17283C' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    stepsSheet.getRow(1).height = 24;
    this.fullSteps.forEach((sr) => {
      const row = stepsSheet.addRow(sr);
      row.eachCell((cell) => {
        cell.font = { name: 'Open Sans', size: 10 };
        cell.alignment = { vertical: 'top', wrapText: true };
        cell.border = { bottom: { style: 'hair', color: { argb: 'FFD8DEE5' } } };
      });
      row.getCell('step').alignment = { vertical: 'top', wrapText: true, indent: sr.depth };
      if (sr.error) {
        row.eachCell((cell) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDECEA' } };
        });
      }
    });
    if (this.fullSteps.length) {
      stepsSheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1 + this.fullSteps.length, column: 8 } };
      stepsSheet.views = [{ state: 'frozen', ySplit: 1 }];
    }

    // ─── Sheet 4: Console Output ──────────────────────────────────
    const logSheet = workbook.addWorksheet('Console Output');
    logSheet.columns = [
      { header: 'Test ID', key: 'testId', width: 10 },
      { header: 'Test',    key: 'test',   width: 40 },
      { header: 'Stream',  key: 'stream', width: 10 },
      { header: 'Output',  key: 'output', width: 120 },
    ];
    logSheet.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17283C' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    this.logRows.forEach((lr) => {
      const row = logSheet.addRow(lr);
      row.eachCell((cell) => {
        cell.font = { name: 'Consolas', size: 9 };
        cell.alignment = { vertical: 'top', wrapText: true };
        cell.border = { bottom: { style: 'hair', color: { argb: 'FFD8DEE5' } } };
      });
    });

    // ─── Save ─────────────────────────────────────────────────────
    const reportsDir = path.resolve(process.cwd(), 'test-reports', 'excel-reports');
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

    const ts = this.startTime.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const specPart = this.specFiles.size === 1
      ? `_${[...this.specFiles][0]}`
      : '';
    const filename = `TestReport${specPart}_${ts}.xlsx`;
    const filepath = path.join(reportsDir, filename);

    await workbook.xlsx.writeFile(filepath);
    console.log(`\n📊 Excel report saved: ${filepath}`);
    console.log(`   ✓ Pass: ${passCount}  ✗ Fail: ${failCount}  ⊘ Skipped: ${skipCount}\n`);
  }
}

export default ExcelReporter;