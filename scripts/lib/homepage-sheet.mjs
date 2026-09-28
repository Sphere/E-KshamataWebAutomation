/**
 * The homepage-layout sheet: every role as ONE row, production vs staging.
 *
 * Written as HTML (with the two screenshots and the pixel diff per role), as an
 * .xlsx sheet, and as text. One file per format, covering every role in the run —
 * not one report per org.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const VERDICT = {
  same: { text: 'Identical', cls: 'ok' },
  info: { text: 'Minor', cls: 'info' },
  warn: { text: 'Review', cls: 'warn' },
  error: { text: 'Broken', cls: 'bad' },
  blocked: { text: 'Not compared', cls: 'blocked' },
};

const pixelText = (p) =>
  !p || p.unavailable ? '—' : p.sizeMismatch ? 'different size' : `${p.percent.toFixed(2)}%`;

/** The differences worth putting in a one-line-per-role sheet. */
const summarise = (row) => {
  if (row.worst === 'blocked') return row.note;
  const parts = row.findings.map((f) => f.title ?? f.what ?? String(f));
  if (!parts.length) {
    return row.pixel && !row.pixel.unavailable && !row.pixel.sizeMismatch && row.pixel.percent > 0
      ? `Same elements; ${row.pixel.percent.toFixed(2)}% of pixels differ.`
      : 'No layout differences found.';
  }
  return parts.slice(0, 4).join(' · ');
};

/** Console and network differences — reported, but not what the verdict grades. */
const noiseOf = (row) => (row.noise?.length ? row.noise.map((f) => f.title).slice(0, 3).join(' · ') : '—');

export async function writeHomepageSheet({ rows, labelA, labelB, urlA, urlB, assetsDir, outDir, stamp, startedAt, durationMs }) {
  mkdirSync(outDir, { recursive: true });
  const base = `homepage-layout_${stamp}`;
  const mins = (durationMs / 60000).toFixed(1);

  const tally = {
    error: rows.filter((r) => r.worst === 'error').length,
    warn: rows.filter((r) => r.worst === 'warn').length,
    info: rows.filter((r) => r.worst === 'info').length,
    same: rows.filter((r) => r.worst === 'same').length,
    blocked: rows.filter((r) => r.worst === 'blocked').length,
  };

  // ── text ──
  const w = Math.max(...rows.map((r) => r.label.length), 12);
  const textPath = resolve(outDir, `${base}.txt`);
  writeFileSync(textPath, [
    `Homepage layout — ${labelA} vs ${labelB}`,
    `${startedAt.toLocaleString()} · ${rows.length} role(s) · ${mins} min`,
    `  ${labelA}: ${urlA}`,
    `  ${labelB}: ${urlB}`,
    '',
    `  ${tally.error} broken · ${tally.warn} to review · ${tally.info} minor · ${tally.same} identical`
      + (tally.blocked ? ` · ${tally.blocked} not compared` : ''),
    '',
    `  ${'ROLE'.padEnd(w)}  ${'VERDICT'.padEnd(14)}${'PIXELS'.padEnd(10)}DIFFERENCES`,
    `  ${'-'.repeat(w)}  ${'-'.repeat(12)}  ${'-'.repeat(8)}  ${'-'.repeat(40)}`,
    ...rows.map((r) =>
      `  ${r.label.padEnd(w)}  ${(VERDICT[r.worst]?.text ?? r.worst).padEnd(14)}${pixelText(r.pixel).padEnd(10)}${summarise(r).slice(0, 90)}`),
    '',
    'Accounts used (production / staging):',
    ...rows.map((r) => `  ${r.label.padEnd(w)}  ${r.accountA}  /  ${r.accountB}`),
    '',
  ].join('\n'), 'utf-8');

  // ── html ──
  const card = (r) => {
    const v = VERDICT[r.worst] ?? VERDICT.info;
    const shots = r.shots?.a && r.shots?.b
      ? `<div class="shots">
           <figure><figcaption>${esc(labelA)}</figcaption><a href="${assetsDir}/${esc(r.shots.a)}" target="_blank"><img src="${assetsDir}/${esc(r.shots.a)}" loading="lazy" alt=""></a></figure>
           <figure><figcaption>${esc(labelB)}</figcaption><a href="${assetsDir}/${esc(r.shots.b)}" target="_blank"><img src="${assetsDir}/${esc(r.shots.b)}" loading="lazy" alt=""></a></figure>
           ${r.shots.diff ? `<figure><figcaption>What changed</figcaption><a href="${assetsDir}/${esc(r.shots.diff)}" target="_blank"><img src="${assetsDir}/${esc(r.shots.diff)}" loading="lazy" alt=""></a></figure>` : ''}
         </div>`
      : '';
    const findings = r.findings?.length
      ? `<ul class="findings">${r.findings.slice(0, 12).map((f) => `<li>${esc(f.title ?? f.what ?? String(f))}${f.detail ? `<span>${esc(String(f.detail).slice(0, 200))}</span>` : ''}</li>`).join('')}</ul>`
      : `<p class="none">${esc(summarise(r))}</p>`;
    return `<details class="role ${v.cls}"${r.worst === 'error' || r.worst === 'blocked' ? ' open' : ''}>
      <summary><span class="badge ${v.cls}">${esc(v.text)}</span><b>${esc(r.label)}</b>
        <span class="px">${esc(pixelText(r.pixel))}</span></summary>
      <div class="body">
        <div class="who">${esc(labelA)}: <code>${esc(r.accountA)}</code> &nbsp;·&nbsp; ${esc(labelB)}: <code>${esc(r.accountB)}</code></div>
        ${findings}${shots}
      </div></details>`;
  };

  const htmlPath = resolve(outDir, `${base}.html`);
  writeFileSync(htmlPath, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Homepage layout — ${esc(labelA)} vs ${esc(labelB)}</title>
<style>
  :root{--navy:#0B2545;--teal:#1B9AAA;--gold:#E8B23A;--ink:#16202E;--muted:#6B7A90;--line:#E3E8EF;--bg:#F7F9FC;
        --ok:#1E7F4F;--bad:#B3261E;--warnc:#8A6D1F;}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);
    font:15px/1.55 "Segoe UI",system-ui,-apple-system,Arial,sans-serif}
  header{background:var(--navy);color:#fff;padding:26px 32px}
  header h1{margin:0 0 6px;font-size:21px;font-weight:650}
  header .meta{color:#B8C6DA;font-size:13px}
  .wrap{max-width:1180px;margin:0 auto;padding:24px 32px 64px}
  .tally{display:flex;gap:12px;flex-wrap:wrap;margin:22px 0}
  .t{flex:1 1 130px;background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px 14px}
  .t b{display:block;font-size:22px;font-weight:660}.t span{color:var(--muted);font-size:12.5px}
  .t.bad b{color:var(--bad)}.t.warn b{color:var(--warnc)}.t.ok b{color:var(--ok)}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);
    border-radius:8px;overflow:hidden;margin-bottom:26px}
  th{background:var(--navy);color:#fff;text-align:left;padding:10px 14px;font-size:13px;font-weight:600}
  td{padding:9px 14px;border-top:1px solid var(--line);font-size:14px;vertical-align:top}
  .badge{display:inline-block;padding:2px 9px;border-radius:99px;font-size:11.5px;font-weight:650;
    white-space:nowrap;margin-right:10px}
  .badge.ok{background:#E6F4EC;color:var(--ok)}.badge.bad{background:#FBE9E7;color:var(--bad)}
  .badge.warn{background:#FDF3DF;color:var(--warnc)}.badge.info{background:#E9F5F7;color:#12707C}
  .badge.blocked{background:#EEF1F5;color:var(--muted)}
  details.role{background:#fff;border:1px solid var(--line);border-radius:8px;margin-bottom:10px}
  details.role.bad{border-left:4px solid var(--bad)}details.role.warn{border-left:4px solid var(--gold)}
  details.role.ok{border-left:4px solid var(--ok)}details.role.blocked{border-left:4px solid var(--muted)}
  details.role.info{border-left:4px solid var(--teal)}
  summary{cursor:pointer;padding:12px 16px;display:flex;align-items:center;gap:4px}
  summary b{font-weight:620}summary .px{margin-left:auto;color:var(--muted);font-size:12.5px}
  .body{padding:0 16px 16px}
  .who{color:var(--muted);font-size:12.5px;margin-bottom:10px}
  .who code{background:var(--bg);padding:1px 6px;border-radius:4px;font-size:12px}
  ul.findings{margin:0 0 14px;padding-left:20px}ul.findings li{margin-bottom:5px}
  ul.findings span{display:block;color:var(--muted);font-size:12.5px;font-family:ui-monospace,Consolas,monospace}
  p.none{color:var(--muted);margin:0 0 14px}
  td.noise{color:var(--muted);font-size:12.5px}
  .shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
  .shots figure{margin:0}.shots figcaption{font-size:12px;color:var(--muted);margin-bottom:5px}
  .shots img{width:100%;border:1px solid var(--line);border-radius:6px;background:#fff}
  footer{color:var(--muted);font-size:12.5px;margin-top:30px;border-top:1px solid var(--line);padding-top:14px}
  @media(max-width:720px){.wrap{padding:16px}}
</style></head><body>
<header>
  <h1>Homepage layout — ${esc(labelA)} vs ${esc(labelB)}</h1>
  <div class="meta">${esc(startedAt.toLocaleString())} · ${rows.length} role(s) · ${esc(mins)} min ·
    ${esc(labelA)} ${esc(urlA)} · ${esc(labelB)} ${esc(urlB)}</div>
</header>
<div class="wrap">
  <div class="tally">
    <div class="t bad"><b>${tally.error}</b><span>broken</span></div>
    <div class="t warn"><b>${tally.warn}</b><span>to review</span></div>
    <div class="t"><b>${tally.info}</b><span>minor</span></div>
    <div class="t ok"><b>${tally.same}</b><span>identical</span></div>
    ${tally.blocked ? `<div class="t"><b>${tally.blocked}</b><span>not compared</span></div>` : ''}
  </div>

  <table>
    <thead><tr><th>Role</th><th>Verdict</th><th>Pixels changed</th><th>Layout differences</th><th>Console / network</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td><b>${esc(r.org)}</b> / ${esc(r.designation)}</td>
      <td><span class="badge ${(VERDICT[r.worst] ?? VERDICT.info).cls}">${esc((VERDICT[r.worst] ?? VERDICT.info).text)}</span></td>
      <td>${esc(pixelText(r.pixel))}</td>
      <td>${esc(summarise(r).slice(0, 160))}</td>
      <td class="noise">${esc(noiseOf(r).slice(0, 90))}</td></tr>`).join('')}
    </tbody>
  </table>

  ${rows.map(card).join('\n  ')}
  <footer>Generated by scripts/compare-orgs.mjs · Ekshamata automation</footer>
</div></body></html>`, 'utf-8');

  // ── xlsx (one sheet, one row per role) ──
  let xlsxPath = null;
  try {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Homepage layout');
    ws.columns = [
      { header: 'Org', key: 'org', width: 14 },
      { header: 'Role', key: 'role', width: 26 },
      { header: 'Verdict', key: 'verdict', width: 14 },
      { header: 'Pixels changed', key: 'pixels', width: 15 },
      { header: 'Layout differences', key: 'diff', width: 64 },
      { header: 'Console / network', key: 'noise', width: 40 },
      { header: `${labelA} account`, key: 'a', width: 34 },
      { header: `${labelB} account`, key: 'b', width: 34 },
    ];
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2545' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of rows) {
      const row = ws.addRow({
        org: r.org, role: r.designation,
        verdict: (VERDICT[r.worst] ?? VERDICT.info).text,
        pixels: pixelText(r.pixel),
        diff: summarise(r),
        noise: noiseOf(r),
        a: r.accountA, b: r.accountB,
      });
      const colour = { error: 'FFB3261E', warn: 'FF8A6D1F', same: 'FF1E7F4F', blocked: 'FF6B7A90' }[r.worst];
      if (colour) row.getCell('verdict').font = { bold: true, color: { argb: colour } };
      row.getCell('diff').alignment = { wrapText: true, vertical: 'top' };
    }
    ws.autoFilter = { from: 'A1', to: 'H1' };
    xlsxPath = resolve(outDir, `${base}.xlsx`);
    // awaited: writeFile is async, and the process exits right after this returns
    await wb.xlsx.writeFile(xlsxPath);
  } catch (e) {
    xlsxPath = null; // exceljs missing — the HTML and text sheets still stand
  }

  return { htmlPath, textPath, xlsxPath };
}
