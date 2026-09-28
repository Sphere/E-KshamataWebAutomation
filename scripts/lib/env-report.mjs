/**
 * The side-by-side comparison report — Tarento-branded HTML, one section per
 * feature: screenshots left/right, the pixel diff, and the findings under it.
 *
 * Images are written next to the HTML in an assets/ folder and referenced
 * relatively, so the report opens straight from disk and stays small enough
 * to email.
 */
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const SEV_LABEL = { error: 'Blocking', warn: 'Review', info: 'FYI', same: 'Match' };

const badge = (sev) => `<span class="badge ${sev}">${SEV_LABEL[sev] || sev}</span>`;

function findingRow(f) {
  return `<div class="finding ${f.severity}">
      <div class="f-head">${badge(f.severity)}<span class="f-kind">${esc(f.kind)}</span><strong>${esc(f.title)}</strong></div>
      ${f.detail ? `<pre>${esc(f.detail)}</pre>` : ''}
    </div>`;
}

function shotCell(label, cap, assetsDir, kind) {
  const file = cap?.shots?.[kind];
  const src = file ? `${assetsDir}/${file}` : '';
  const controls = cap?.counts?.buttons ?? 0;
  const meta = cap
    ? `${cap.status || '—'} · ${cap.timings?.idleMs ?? '—'} ms · ${controls} control${controls === 1 ? '' : 's'}`
    : 'not captured';
  return `<figure>
      <figcaption><span class="env-name">${esc(label)}</span><span class="env-meta">${esc(meta)}</span></figcaption>
      ${src ? `<a href="${esc(src)}" target="_blank"><img loading="lazy" src="${esc(src)}" alt="${esc(label)}" /></a>` : '<div class="noshot">no screenshot</div>'}
    </figure>`;
}

/** What the run actually did on this feature — url, steps walked, checks applied. */
function coverageBlock(r, labelA, labelB) {
  const steps = r.A?.stepsRun?.length ? r.A.stepsRun : r.B?.stepsRun || [];
  const stepList = steps.length
    ? `<ol class="steps">${steps.map((s) => `<li class="${s.ok ? 'ok' : 'bad'}">${esc(s.label)}${s.ok ? '' : ' — failed: ' + esc(s.error || '')}</li>`).join('')}</ol>`
    : '<p class="muted">No steps — the page is compared exactly as it first lands.</p>';
  return `<details class="checked">
      <summary>What was checked here</summary>
      <div class="checked-body">
        ${r.route.note ? `<p class="note">${esc(r.route.note)}</p>` : ''}
        <p><strong>Opened:</strong> <code>${esc(r.A?.url || r.route.path)}</code> on both environments, same viewport, at the same moment.</p>
        <p><strong>Walked into the screen:</strong></p>
        ${stepList}
        <p><strong>Then compared:</strong> screenshot pixels · headings · buttons and controls · form fields ·
          navigation and menu items · tabs · card titles · dropdown options · images (alt + file) · icons · links ·
          a census of every visible element by tag · page copy · title and language · HTTP status and redirects ·
          console errors · uncaught JS errors · failing network requests · time to settle · front-end build hash.</p>
        <p class="muted"><strong>Not covered:</strong> anything past this screen unless it is listed as a step above —
          no forms are submitted, no data is created, and journeys (signup, course completion, quizzes) are the
          Playwright specs' job, not this comparison's.</p>
      </div>
    </details>`;
}

function routeSection(r, assetsDir, labelA, labelB) {
  const diffSrc = r.diffImage ? `${assetsDir}/${r.diffImage}` : '';
  const pxLine = r.pixel?.sizeMismatch
    ? `page heights differ (${r.pixel.a.w}×${r.pixel.a.h} vs ${r.pixel.b.w}×${r.pixel.b.h})`
    : r.pixel && !r.pixel.unavailable
      ? `${r.pixel.percent.toFixed(2)}% of viewport pixels differ`
      : '';

  return `<section id="${esc(r.route.id)}" class="route ${r.worst}" data-worst="${r.worst}">
    <header class="r-head">
      <div>
        <h2>${esc(r.route.name)} ${badge(r.worst)}</h2>
        <div class="r-path"><code>${esc(r.route.path)}</code>${r.route.auth ? '<span class="tag">signed in</span>' : ''}${pxLine ? `<span class="tag px">${esc(pxLine)}</span>` : ''}</div>
      </div>
      <div class="r-count">${r.findings.length} finding${r.findings.length === 1 ? '' : 's'}</div>
    </header>
    <div class="shots">
      ${shotCell(labelA, r.A, assetsDir, 'viewport')}
      ${shotCell(labelB, r.B, assetsDir, 'viewport')}
      ${diffSrc
        ? `<figure><figcaption><span class="env-name">Pixel diff</span><span class="env-meta">${esc(pxLine)}</span></figcaption>
             <a href="${esc(diffSrc)}" target="_blank"><img loading="lazy" src="${esc(diffSrc)}" alt="pixel diff" /></a></figure>`
        : '<figure class="ok"><figcaption><span class="env-name">Pixel diff</span></figcaption><div class="noshot match">viewport renders identical</div></figure>'}
    </div>
    ${(r.A?.shots?.full || r.B?.shots?.full)
      ? `<div class="fulls">Full-page: ${[['A', labelA, r.A], ['B', labelB, r.B]]
          .filter(([, , c]) => c?.shots?.full)
          .map(([, l, c]) => `<a href="${esc(assetsDir)}/${esc(c.shots.full)}" target="_blank">${esc(l)}</a>`)
          .join(' · ')}</div>`
      : ''}
    ${coverageBlock(r, labelA, labelB)}
    <div class="findings">
      ${r.findings.length ? r.findings.map(findingRow).join('\n') : '<div class="finding same"><div class="f-head">' + badge('same') + '<strong>No differences detected</strong></div></div>'}
    </div>
  </section>`;
}

/**
 * @param {object} data
 * @param {string} data.labelA / data.labelB   environment names
 * @param {string} data.urlA / data.urlB       environment base URLs
 * @param {object[]} data.routes               diffRoute() results (+ diffImage)
 * @param {object[]} data.api                  diffApi() results
 * @param {object|null} data.catalogue         diffCatalogue() result
 * @param {string} data.assetsDir              folder name holding the images
 * @param {string} data.startedAt
 * @param {number} data.durationMs
 * @param {string} data.authNote
 */
export function renderReport(data) {
  const { labelA, labelB, urlA, urlB, routes, api, catalogue, assetsDir, startedAt, durationMs, authNote } = data;

  const counts = { error: 0, warn: 0, info: 0, same: 0 };
  for (const r of routes) counts[r.worst] = (counts[r.worst] || 0) + 1;
  const totalFindings = routes.reduce((n, r) => n + r.findings.length, 0) +
    api.reduce((n, r) => n + r.findings.length, 0);

  const apiRows = api
    .map((r) => `<tr class="${r.worst}">
        <td class="tc">${esc(r.a.name)}</td>
        <td><code>${esc(r.a.path)}</code></td>
        <td class="center">${r.a.status || '—'}</td>
        <td class="center">${r.b.status || '—'}</td>
        <td class="center num">${r.a.count ?? '—'}</td>
        <td class="center num">${r.b.count ?? '—'}</td>
        <td class="center num">${r.a.ms} / ${r.b.ms} ms</td>
        <td>${r.findings.length ? r.findings.map((f) => esc(f.title)).join('; ') : '<span class="muted">match</span>'}</td>
      </tr>`)
    .join('\n');

  const catalogueBlock = catalogue
    ? `<section class="panel">
        <h2>Course catalogue parity</h2>
        <p class="sub">${catalogue.totalA} course${catalogue.totalA === 1 ? '' : 's'} on ${esc(labelA)} · ${catalogue.totalB} on ${esc(labelB)}</p>
        <div class="cat-cols">
          <div><h3>Only on ${esc(labelA)} (${catalogue.onlyA.length})</h3>
            ${catalogue.onlyA.length ? `<ul>${catalogue.onlyA.slice(0, 60).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>${catalogue.onlyA.length > 60 ? `<p class="muted">… and ${catalogue.onlyA.length - 60} more</p>` : ''}` : '<p class="muted">nothing exclusive</p>'}
          </div>
          <div><h3>Only on ${esc(labelB)} (${catalogue.onlyB.length})</h3>
            ${catalogue.onlyB.length ? `<ul>${catalogue.onlyB.slice(0, 60).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>${catalogue.onlyB.length > 60 ? `<p class="muted">… and ${catalogue.onlyB.length - 60} more</p>` : ''}` : '<p class="muted">nothing exclusive</p>'}
          </div>
        </div>
      </section>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Ekshamata — ${esc(labelA)} vs ${esc(labelB)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;600;700&display=swap" rel="stylesheet" />
<style>
  :root{
    --navy:#17283C; --teal:#1E8F8E; --teal-50:#E3F7F6; --gold:#F0A500; --gold-50:#FEF6E0; --gold-700:#9A6800;
    --off-white:#F6F7F9; --light-gray:#D8DEE5; --mid-gray:#7C8696; --almost-black:#0D1218;
    --success:#15803D; --success-lt:#DCFCE7; --error:#B91C1C; --error-lt:#FEE2E2;
    --warning:#B45309; --warning-lt:#FEF3C7;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--off-white);color:var(--almost-black);
    font-family:'Open Sans',system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.6}
  .wrap{max-width:1600px;margin:0 auto;padding:24px}
  header.top{background:var(--navy);color:#fff;border-radius:8px 8px 0 0;padding:24px;border-bottom:4px solid var(--teal)}
  header.top h1{margin:0;font-size:24px;font-weight:700}
  header.top .meta{margin-top:6px;color:#BEC5CE;font-size:13px}
  header.top code{color:#fff;background:rgba(255,255,255,.10);padding:1px 6px;border-radius:4px}
  .cards{display:grid;grid-template-columns:repeat(5,1fr);gap:16px;background:#fff;padding:24px;
    border:1px solid var(--light-gray);border-top:0;border-radius:0 0 8px 8px}
  .card{border:1px solid var(--light-gray);border-radius:8px;padding:16px;text-align:center}
  .card .n{font-size:28px;font-weight:700;color:var(--navy)}
  .card .l{font-size:12px;font-weight:600;color:var(--mid-gray);text-transform:uppercase;letter-spacing:.04em}
  .card.err .n{color:var(--error)} .card.wrn .n{color:var(--warning)} .card.ok .n{color:var(--success)}
  .card.kpi{background:var(--gold-50);border-color:var(--gold)} .card.kpi .n{color:var(--gold-700)}
  .controls{display:flex;gap:8px;align-items:center;margin:24px 0 8px;flex-wrap:wrap}
  .controls button{font:inherit;font-weight:600;padding:6px 14px;border-radius:9999px;cursor:pointer;
    border:1px solid var(--light-gray);background:#fff;color:var(--navy)}
  .controls button.on{background:var(--navy);color:#fff;border-color:var(--navy)}
  .panel{background:#fff;border:1px solid var(--light-gray);border-radius:8px;padding:20px;margin:16px 0}
  .panel h2{margin:0 0 4px;font-size:18px;color:var(--navy)}
  .panel .sub{margin:0 0 12px;color:var(--mid-gray);font-size:13px}
  table{width:100%;border-collapse:collapse}
  thead th{background:var(--navy);color:#fff;text-align:left;font-weight:600;font-size:13px;padding:10px}
  thead th.center{text-align:center}
  tbody td{padding:8px 10px;border-top:1px solid var(--light-gray);vertical-align:top}
  tbody tr:nth-child(even){background:var(--off-white)}
  tbody tr.error{background:var(--error-lt)}
  td.center{text-align:center} td.num{font-variant-numeric:tabular-nums} td.tc{font-weight:700;color:var(--navy)}
  .cat-cols{display:grid;grid-template-columns:1fr 1fr;gap:24px}
  .cat-cols h3{font-size:14px;color:var(--navy);margin:0 0 6px}
  .cat-cols ul{margin:0;padding-left:18px;max-height:280px;overflow:auto}
  .muted{color:var(--mid-gray)}
  .legend-table td{font-size:13px}
  .legend-table td:first-child{white-space:nowrap;width:110px}
  .legend-table td:last-child{width:230px;color:var(--mid-gray)}
  details.checked{border:1px dashed var(--light-gray);border-radius:6px;margin:12px 0;background:var(--off-white)}
  details.checked summary{cursor:pointer;padding:8px 12px;font-weight:600;color:var(--navy);font-size:13px}
  details.checked .checked-body{padding:0 14px 12px;font-size:13px}
  details.checked p{margin:6px 0}
  details.checked .note{color:var(--navy);font-weight:600}
  ol.steps{margin:6px 0;padding-left:22px}
  ol.steps li.ok::marker{color:var(--success)}
  ol.steps li.bad{color:var(--error)}
  section.route{background:#fff;border:1px solid var(--light-gray);border-left:4px solid var(--light-gray);
    border-radius:8px;margin:16px 0;padding:20px}
  section.route.error{border-left-color:var(--error)}
  section.route.warn{border-left-color:var(--warning)}
  section.route.info{border-left-color:var(--teal)}
  section.route.same{border-left-color:var(--success)}
  .r-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
  .r-head h2{margin:0;font-size:18px;color:var(--navy)}
  .r-path{color:var(--mid-gray);font-size:12px;margin-top:2px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .r-count{color:var(--mid-gray);font-size:12px;white-space:nowrap}
  .tag{background:var(--teal-50);color:var(--navy);border-radius:9999px;padding:1px 8px;font-size:11px;font-weight:600}
  .tag.px{background:var(--gold-50);color:var(--gold-700)}
  .shots{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:16px 0}
  figure{margin:0;border:1px solid var(--light-gray);border-radius:6px;overflow:hidden;background:var(--off-white)}
  figcaption{display:flex;justify-content:space-between;gap:8px;padding:6px 10px;background:var(--navy);color:#fff;font-size:12px}
  .env-name{font-weight:600} .env-meta{color:#BEC5CE}
  figure img{display:block;width:100%;height:auto}
  .noshot{padding:32px;text-align:center;color:var(--mid-gray);font-size:12px}
  .noshot.match{color:var(--success);font-weight:600}
  .fulls{font-size:12px;color:var(--mid-gray);margin-bottom:12px}
  .fulls a{color:var(--teal);font-weight:600}
  .finding{border:1px solid var(--light-gray);border-radius:6px;padding:10px 12px;margin:8px 0;background:#fff}
  .finding.error{border-color:#F3BEBE;background:#FFF8F8}
  .finding.warn{border-color:#F3DFB0;background:#FFFCF5}
  .finding.same{border-color:#BEE7CC;background:#F7FFFA}
  .f-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .f-kind{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--mid-gray);font-weight:600}
  .finding pre{margin:8px 0 0;white-space:pre-wrap;word-break:break-word;font-size:12px;color:#324055;
    background:var(--off-white);border-radius:4px;padding:8px;max-height:260px;overflow:auto}
  .badge{display:inline-block;padding:2px 10px;border-radius:9999px;font-size:12px;font-weight:600}
  .badge.error{background:var(--error-lt);color:var(--error)}
  .badge.warn{background:var(--warning-lt);color:var(--warning)}
  .badge.info{background:var(--teal-50);color:var(--navy)}
  .badge.same{background:var(--success-lt);color:var(--success)}
  footer{color:var(--mid-gray);font-size:12px;padding:16px 4px;text-align:center}
  @media (max-width:1100px){.shots{grid-template-columns:1fr}.cards{grid-template-columns:repeat(2,1fr)}.cat-cols{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <h1>Environment comparison — ${esc(labelA)} vs ${esc(labelB)}</h1>
    <div class="meta">${esc(labelA)}: <code>${esc(urlA)}</code> &nbsp;·&nbsp; ${esc(labelB)}: <code>${esc(urlB)}</code></div>
    <div class="meta">${esc(startedAt)} · ${(durationMs / 1000).toFixed(1)}s · ${esc(authNote)}</div>
  </header>

  <div class="cards">
    <div class="card kpi"><div class="n">${totalFindings}</div><div class="l">Differences</div></div>
    <div class="card err"><div class="n">${counts.error || 0}</div><div class="l">Blocking</div></div>
    <div class="card wrn"><div class="n">${counts.warn || 0}</div><div class="l">Review</div></div>
    <div class="card"><div class="n">${counts.info || 0}</div><div class="l">FYI</div></div>
    <div class="card ok"><div class="n">${counts.same || 0}</div><div class="l">Identical</div></div>
  </div>

  <section class="panel legend">
    <h2>How to read this report</h2>
    <p class="sub">Each feature below was opened on both environments at the same moment and compared. The grade is the worst thing found on it.</p>
    <table class="legend-table">
      <thead><tr><th>Grade</th><th>What it means</th><th>What to do</th></tr></thead>
      <tbody>
        <tr><td>${badge('error')}</td><td><strong>The portal itself is broken or missing on one side</strong> — page did not load, renders blank, different HTTP status, one of Ekshamata's own API calls failing, an uncaught app error, or a configured step that works on one environment and not the other.</td><td>Fix before release. The run exits with code 1 when any of these exist.</td></tr>
        <tr><td>${badge('warn')}</td><td><strong>A real difference worth a human look, but not the portal breaking</strong> — a button, menu item, tab or form field present on one side only; visual/pixel drift; a third-party script or widget failing on one side; one environment 2×+ slower to settle.</td><td>Eyeball the screenshots and decide: expected change, or a regression?</td></tr>
        <tr><td>${badge('info')}</td><td><strong>Expected to differ</strong> — different front-end build, content and copy changes, links/images/cards that follow content, element counts.</td><td>Read for context. Usually just staging being ahead or behind.</td></tr>
        <tr><td>${badge('same')}</td><td><strong>Nothing differed</strong> on any of the checks.</td><td>Nothing.</td></tr>
      </tbody>
    </table>
    <p class="sub" style="margin-top:12px">
      <strong>Scope of this tool:</strong> it compares each screen <em>as it is reached</em> — the page is loaded (and any
      configured steps walked) and then everything on it is compared. It does not run journeys: no signup is submitted,
      no course is completed, no quiz is answered, nothing is saved. Those are the Playwright specs
      (<code>npm run go</code>). Expand <em>“What was checked here”</em> under any feature to see exactly what was
      opened, walked and compared.
    </p>
  </section>

  <div class="controls">
    <strong>Show:</strong>
    <button data-filter="all" class="on">Everything</button>
    <button data-filter="diff">Differences only</button>
    <button data-filter="error">Blocking only</button>
  </div>

  ${routes.map((r) => routeSection(r, assetsDir, labelA, labelB)).join('\n')}

  ${api.length
      ? `<section class="panel">
      <h2>API parity</h2>
      <p class="sub">Same request, both environments.</p>
      <table>
        <thead><tr><th>Endpoint</th><th>Path</th><th class="center">${esc(labelA)} status</th><th class="center">${esc(labelB)} status</th>
          <th class="center">${esc(labelA)} count</th><th class="center">${esc(labelB)} count</th><th class="center">Latency</th><th>Notes</th></tr></thead>
        <tbody>${apiRows}</tbody>
      </table>
    </section>`
      : ''}

  ${catalogueBlock}

  <footer>Generated by scripts/compare-env.mjs · Ekshamata automation</footer>
</div>
<script>
  const buttons = document.querySelectorAll('.controls button');
  buttons.forEach((b) => b.addEventListener('click', () => {
    buttons.forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    const mode = b.dataset.filter;
    document.querySelectorAll('section.route').forEach((s) => {
      const w = s.dataset.worst;
      const show = mode === 'all' || (mode === 'diff' && w !== 'same') || (mode === 'error' && w === 'error');
      s.style.display = show ? '' : 'none';
    });
  }));
</script>
</body>
</html>`;
}
