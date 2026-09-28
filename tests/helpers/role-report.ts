/**
 * Role verification sweep — collector + report writer.
 *
 * One row per org x designation: which homepage that role gets, what the
 * "For You" catalogue actually contains, and a capture of the homepage itself.
 *
 * Rows are appended as JSON lines the moment they are produced. Playwright
 * restarts its worker process after a failing test, which wipes any in-memory
 * array — a file survives that, so one bad role cannot erase the sweep.
 *
 * Outputs (test-reports/role-sweep/):
 *   RoleSweep_<timestamp>.xlsx   Roles + For-You Catalogue + Homepage Items
 *   RoleSweep_<timestamp>.html   branded table with each homepage screenshot
 *   latest.html                  always the newest
 */
import * as fs from 'fs';
import * as path from 'path';
import ExcelJS from 'exceljs';
import { ORGS } from '../../src/config/orgs';

const DIR = path.resolve(process.cwd(), 'test-reports', 'role-sweep');
const LOG = path.join(DIR, 'rows.jsonl');

export interface RoleRow {
  /** Short key, e.g. "BNRC". */
  org: string;
  /** Full org name from the config. */
  orgName: string;
  /** organisationId — the same value on production and staging. */
  orgId: string;
  /** What that id resolves to on the environment swept; '' when it did not. */
  orgChannel: string;
  designation: string;
  email: string;
  /** competency | programs | courses | none | error */
  homepage: string;
  competencies: number | null;
  programs: number | null;
  forYou: number | null;
  started: number | null;
  completed: number | null;
  /** Course titles in the For-You catalogue. */
  catalogue: string[];
  /** Competency / program names shown on the homepage. */
  homeItems: string[];
  /** base64 PNG of the homepage. */
  screenshot?: string;
  note: string;
}

export function resetRoleRows(): void {
  try { fs.rmSync(LOG, { force: true }); } catch { /* ignore */ }
}

export function recordRole(row: RoleRow): void {
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify(row) + '\n', 'utf-8');
}

function readRows(): RoleRow[] {
  if (!fs.existsSync(LOG)) return [];
  const byKey = new Map<string, RoleRow>();
  for (const line of fs.readFileSync(LOG, 'utf-8').split('\n').filter(Boolean)) {
    try {
      const r = JSON.parse(line) as RoleRow;
      // Rows written before the org name/id were recorded — and rows from an
      // earlier sweep of other roles — would otherwise show blank cells. The
      // name and id are static config, so fill them in rather than leave holes.
      const cfg = ORGS[r.org];
      if (cfg) {
        r.orgName = r.orgName || cfg.name;
        r.orgId = r.orgId || cfg.orgId;
      }
      r.orgChannel = r.orgChannel ?? '';
      byKey.set(r.org + '/' + r.designation, r);
    } catch { /* skip a partial line */ }
  }
  return [...byKey.values()];
}

function esc(s: string): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function headerRow(sheet: ExcelJS.Worksheet, cols: number): void {
  sheet.getRow(1).eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17283C' } };
    c.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  sheet.getRow(1).height = 24;
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  void cols;
}

/** Write the Excel + HTML sweep reports. Returns the paths written. */
export async function writeRoleReports(): Promise<string[]> {
  const rows = readRows();
  if (!rows.length) return [];
  fs.mkdirSync(DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = path.join(DIR, 'RoleSweep_' + stamp);

  // ── Excel ────────────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();

  const roles = wb.addWorksheet('Roles');
  roles.columns = [
    { header: 'Org', key: 'org', width: 12 },
    { header: 'Org name', key: 'orgName', width: 42 },
    { header: 'Org ID', key: 'orgId', width: 26 },
    { header: 'Org on this env', key: 'orgChannel', width: 34 },
    { header: 'Designation', key: 'designation', width: 24 },
    { header: 'User', key: 'email', width: 34 },
    { header: 'Homepage', key: 'homepage', width: 13 },
    { header: 'Competencies', key: 'competencies', width: 13 },
    { header: 'Programs', key: 'programs', width: 10 },
    { header: 'For You', key: 'forYou', width: 9 },
    { header: 'Started', key: 'started', width: 9 },
    { header: 'Completed', key: 'completed', width: 10 },
    { header: 'Catalogue', key: 'catalogueCount', width: 10 },
    { header: 'Note', key: 'note', width: 40 },
  ];
  rows.forEach((r) => roles.addRow({ ...r, catalogueCount: r.catalogue.length }));
  headerRow(roles, 14);
  roles.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1 + rows.length, column: 14 } };

  const cat = wb.addWorksheet('For-You Catalogue');
  cat.columns = [
    { header: 'Org', key: 'org', width: 12 },
    { header: 'Org name', key: 'orgName', width: 42 },
    { header: 'Org ID', key: 'orgId', width: 26 },
    { header: 'Designation', key: 'designation', width: 24 },
    { header: '#', key: 'n', width: 5 },
    { header: 'Course', key: 'course', width: 90 },
  ];
  for (const r of rows) {
    r.catalogue.forEach((course, i) =>
      cat.addRow({ org: r.org, orgName: r.orgName, orgId: r.orgId, designation: r.designation, n: i + 1, course }));
  }
  headerRow(cat, 6);

  const home = wb.addWorksheet('Homepage Items');
  home.columns = [
    { header: 'Org', key: 'org', width: 12 },
    { header: 'Org name', key: 'orgName', width: 42 },
    { header: 'Org ID', key: 'orgId', width: 26 },
    { header: 'Designation', key: 'designation', width: 24 },
    { header: '#', key: 'n', width: 5 },
    { header: 'Item on homepage', key: 'item', width: 90 },
  ];
  for (const r of rows) {
    r.homeItems.forEach((item, i) =>
      home.addRow({ org: r.org, orgName: r.orgName, orgId: r.orgId, designation: r.designation, n: i + 1, item }));
  }
  headerRow(home, 6);

  // One row per org rather than per role: the full name and the id, and what
  // that id resolves to on the environment swept. Production and staging carry
  // the SAME org ids, and this sheet is where that stops being an assumption.
  const orgSheet = wb.addWorksheet('Orgs');
  orgSheet.columns = [
    { header: 'Org', key: 'org', width: 12 },
    { header: 'Full name', key: 'orgName', width: 52 },
    { header: 'Org ID', key: 'orgId', width: 26 },
    { header: 'Name on this environment', key: 'orgChannel', width: 52 },
    { header: 'Roles swept', key: 'roles', width: 12 },
  ];
  const byOrg = new Map<string, RoleRow[]>();
  for (const row of rows) byOrg.set(row.org, [...(byOrg.get(row.org) ?? []), row]);
  for (const [key, list] of byOrg) {
    orgSheet.addRow({
      org: key,
      orgName: list[0].orgName,
      orgId: list[0].orgId,
      orgChannel: list.find((x) => x.orgChannel)?.orgChannel || '— not resolved here —',
      roles: list.length,
    });
  }
  headerRow(orgSheet, 5);

  // Which environment these org ids were read on — the sheet is meaningless
  // without it, since prod and staging are separate backends.
  const info = wb.addWorksheet('Run');
  info.columns = [
    { header: 'Field', key: 'k', width: 22 },
    { header: 'Value', key: 'v', width: 60 },
  ];
  const envUrl = process.env.BASE_URL ?? 'https://ekshamata.aastrika.org';
  info.addRow({ k: 'Environment', v: envUrl });
  info.addRow({ k: 'Swept at', v: new Date().toLocaleString() });
  info.addRow({ k: 'Roles', v: rows.length });
  info.addRow({ k: 'Orgs', v: new Set(rows.map((x) => x.org)).size });
  info.addRow({ k: 'Ids resolved here', v: rows.filter((x) => x.orgChannel).length + ' of ' + rows.length });
  headerRow(info, 2);

  await wb.xlsx.writeFile(base + '.xlsx');

  // ── HTML ─────────────────────────────────────────────────────────
  const NAVY = '#0B2545';
  const TEAL = '#1B9AAA';
  const GOLD = '#E8B02B';
  const MUTED = '#7C8696';

  const summary = rows.map((r) =>
    '<tr><td>' + esc(r.org) + '</td><td>' + esc(r.orgName) + '</td><td class="id">' + esc(r.orgId) + '</td>'
    + '<td>' + esc(r.designation) + '</td><td>' + esc(r.homepage) + '</td>'
    + '<td class="num">' + (r.competencies ?? '—') + '</td>'
    + '<td class="num">' + (r.programs ?? '—') + '</td>'
    + '<td class="num">' + (r.forYou ?? '—') + '</td>'
    + '<td class="num">' + r.catalogue.length + '</td>'
    + '<td>' + esc(r.email) + '</td></tr>').join('');

  const list = (items: string[]) =>
    items.length
      ? '<ol>' + items.map((c) => '<li>' + esc(c) + '</li>').join('') + '</ol>'
      : '<p class="none">none</p>';

  const cards = rows.map((r) =>
    '<section class="role"><h3>' + esc(r.org) + ' — ' + esc(r.orgName) + ' · ' + esc(r.designation) + '</h3>'
    + '<p class="meta">' + esc(r.orgName) + ' · <span class="id">' + esc(r.orgId) + '</span>'
    + (r.orgChannel && r.orgChannel !== r.orgName ? ' · on this environment: "' + esc(r.orgChannel) + '"' : '')
    + (!r.orgChannel ? ' · <span class="note">id did not resolve on this environment</span>' : '')
    + '</p>'
    + '<p class="meta">' + esc(r.email) + ' — homepage: <b>' + esc(r.homepage) + '</b>'
    + (r.competencies != null ? ' · competencies ' + r.competencies : '')
    + (r.programs != null ? ' · programs ' + r.programs : '')
    + (r.forYou != null ? ' · For You ' + r.forYou : '')
    + (r.note ? ' · <span class="note">' + esc(r.note) + '</span>' : '')
    + '</p><div class="cols"><div>'
    + '<h4>For-You catalogue (' + r.catalogue.length + ')</h4>' + list(r.catalogue)
    + (r.homeItems.length ? '<h4>On the homepage (' + r.homeItems.length + ')</h4>' + list(r.homeItems) : '')
    + '</div><figure>'
    + (r.screenshot
      ? '<img src="data:image/png;base64,' + r.screenshot + '" alt="homepage"/><figcaption>homepage</figcaption>'
      : '<figcaption class="none">no capture</figcaption>')
    + '</figure></div></section>').join('');

  const orgRows = [...new Map(rows.map((x) => [x.org, x])).values()]
    .map((x) => '<tr><td>' + esc(x.org) + '</td><td>' + esc(x.orgName) + '</td>'
      + '<td class="id">' + esc(x.orgId) + '</td><td>'
      + (x.orgChannel ? esc(x.orgChannel) : '<span class="none">not resolved here</span>') + '</td>'
      + '<td class="num">' + rows.filter((y) => y.org === x.org).length + '</td></tr>').join('');

  const css = [
    '*{box-sizing:border-box}',
    "body{margin:0;font-family:'Open Sans',Segoe UI,Arial,sans-serif;color:#1F2933;font-size:12px;line-height:1.5}",
    '.wrap{max-width:1150px;margin:0 auto;padding:24px}',
    'header{background:' + NAVY + ';color:#fff;padding:22px 24px;border-radius:6px}',
    'header h1{margin:0 0 4px;font-size:20px} header p{margin:2px 0;color:#C7D2E0;font-size:11px}',
    'h2{color:' + NAVY + ';font-size:15px;margin:22px 0 8px;border-bottom:2px solid ' + GOLD + ';padding-bottom:4px}',
    'table{width:100%;border-collapse:collapse;font-size:11px}',
    'th{background:' + NAVY + ';color:#fff;text-align:left;padding:6px 8px}',
    'td{border-bottom:1px solid #E9EDF2;padding:5px 8px;vertical-align:top} td.num{text-align:right}',
    '.role{border:1px solid #E3E8EF;border-radius:6px;padding:12px 14px;margin:12px 0;page-break-inside:avoid}',
    '.role h3{margin:0 0 4px;font-size:13px;color:' + NAVY + '}',
    '.meta{margin:0 0 8px;color:' + MUTED + ';font-size:10.5px} .note{color:#B9770E}',
    'h4{margin:8px 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:' + TEAL + '}',
    '.cols{display:flex;gap:14px} .cols>div{flex:1} figure{margin:0;flex:0 0 46%}',
    'figure img{width:100%;border:1px solid #E3E8EF;border-radius:4px}',
    'figcaption{color:' + MUTED + ';font-size:9.5px;margin-top:3px}',
    'ol{margin:0;padding-left:18px} li{margin:1px 0}',
    '.none{color:' + MUTED + ';font-style:italic}',
    '.id{font-family:Consolas,monospace;font-size:10px;color:' + MUTED + '}',
    'td.id{white-space:nowrap}',
  ].join('\n');

  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"/>'
    + '<title>e-kshamata — Role Verification Sweep</title><style>' + css + '</style></head>'
    + '<body><div class="wrap"><header><h1>Role Verification Sweep</h1>'
    + '<p>' + rows.length + ' roles · ' + new Date().toLocaleString() + '</p>'
    + '<p>' + esc(process.env.BASE_URL ?? 'https://ekshamata.aastrika.org') + '</p></header>'
    + '<h2>Summary</h2><table><thead><tr><th>Org</th><th>Org name</th><th>Org ID</th><th>Designation</th><th>Homepage</th>'
    + '<th>Competencies</th><th>Programs</th><th>For You</th><th>Catalogue</th><th>User</th></tr></thead>'
    + '<tbody>' + summary + '</tbody></table>'
    + '<h2>Orgs on this environment</h2><table><thead><tr><th>Org</th><th>Full name</th>'
    + '<th>Org ID</th><th>Name on this environment</th><th>Roles</th></tr></thead>'
    + '<tbody>' + orgRows + '</tbody></table>'
    + '<h2>Per role — homepage capture and catalogue</h2>' + cards
    + '</div></body></html>';

  fs.writeFileSync(base + '.html', html, 'utf-8');
  fs.writeFileSync(path.join(DIR, 'latest.html'), html, 'utf-8');
  return [base + '.xlsx', base + '.html'];
}
