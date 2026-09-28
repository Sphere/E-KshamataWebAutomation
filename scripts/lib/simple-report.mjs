/**
 * The plain-English version of the comparison.
 *
 * Two outputs, same content:
 *   • a simple HTML page — one table per feature, PRODUCTION and STAGING in
 *     their own columns, the two screenshots underneath in the same columns
 *   • a .txt summary — the same tables in plain text, for pasting into a
 *     ticket, an email or a chat
 *
 * No jargon: every row says what was checked in words, and every difference is
 * written as a sentence.
 */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Three levels, in priority order. "Broken" is deliberately narrow: it means
 * the page does not work on one side, not that something about it differs.
 * Grading a stray console error as broken made every release look on fire and
 * buried the pages that genuinely were.
 */
const VERDICT = {
  error: { text: 'P1 BROKEN — does not work on one side', cls: 'bad' },
  warn: { text: 'P2 MAJOR — a real difference to check', cls: 'warn' },
  info: { text: 'P3 MINOR — cosmetic or expected drift', cls: 'info' },
  same: { text: 'SAME ON BOTH', cls: 'ok' },
};

const secs = (ms) => (ms == null ? '—' : (ms / 1000).toFixed(1) + ' s');
const yn = (cap) => (cap?.navError ? 'NO — it failed to open' : cap?.isBlank ? 'opened but blank' : 'yes');

/**
 * The side-by-side rows: what was checked, and each environment's answer.
 * A row is [label, valueA, valueB, differs?] — `differs` defaults to "the two
 * values are not identical", but timing gets a tolerance so a half-second of
 * network jitter is not presented as a difference.
 */
function rows(A, B) {
  const c = (cap, key) => cap?.counts?.[key] ?? 0;
  const tA = A?.timings?.idleMs ?? 0;
  const tB = B?.timings?.idleMs ?? 0;
  const timingMatters = tA && tB && (Math.max(tA, tB) / Math.min(tA, tB) >= 1.5 || Math.abs(tA - tB) >= 2000);
  return [
    ['Did the page open?', yn(A), yn(B)],
    ['Server answer (200 = fine)', A?.status || '—', B?.status || '—'],
    ['Time until the page settled', secs(A?.timings?.idleMs), secs(B?.timings?.idleMs), timingMatters],
    ['Headings on the page', c(A, 'headings'), c(B, 'headings')],
    ['Buttons and clickable controls', c(A, 'buttons'), c(B, 'buttons')],
    ['Form fields (boxes to type in)', c(A, 'inputs'), c(B, 'inputs')],
    ['Links', c(A, 'links'), c(B, 'links')],
    ['Pictures shown', c(A, 'images'), c(B, 'images')],
    ['Pictures that failed to load', c(A, 'brokenImages'), c(B, 'brokenImages')],
    ['Cards / tiles', c(A, 'cards'), c(B, 'cards')],
    ['Everything on screen (element count)', c(A, 'elements'), c(B, 'elements')],
    ['Errors in the browser console', (A?.consoleErrors?.length || 0) + (A?.pageErrors?.length || 0),
      (B?.consoleErrors?.length || 0) + (B?.pageErrors?.length || 0)],
    ['Files / requests that failed', A?.failedRequests?.length || 0, B?.failedRequests?.length || 0],
    ['Website version (build file)', buildOf(A), buildOf(B)],
  ];
}

const buildOf = (cap) => {
  const main = (cap?.bundles || []).find((b) => /^main\./i.test(b));
  return main ? main.replace(/^main\./, '').replace(/\.js$/, '') : '—';
};

/**
 * Every finding, rewritten as a sentence a non-tester can act on.
 * Returns [] when the two sides matched.
 */
function plainDifferences(r, labelA, labelB) {
  const out = [];
  const items = (detail, max = 6) =>
    String(detail || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, max);

  for (const f of r.findings) {
    const t = f.title;
    switch (f.kind) {
      case 'nav':
        out.push({ level: f.severity, text: `The page did not open. ${t}`, detail: items(f.detail, 2) });
        break;
      case 'status':
        out.push({ level: f.severity, text: `The two sites answered differently when the page was requested — ${f.detail}.`, detail: [] });
        break;
      case 'blank':
        out.push({ level: f.severity, text: `${t} — nothing was drawn on the screen.`, detail: [] });
        break;
      case 'step':
        out.push({ level: f.severity, text: `${t}. The comparison could not reach the screen it was meant to check.`, detail: items(f.detail, 2) });
        break;
      case 'console':
        out.push({
          level: f.severity,
          text: /third-party/i.test(t)
            ? `An embedded outside tool (chat widget, analytics) threw errors on ${sideOf(t, labelA, labelB)} only. Usually not the portal's own fault, but users may see a broken widget.`
            : `The browser reported errors on ${sideOf(t, labelA, labelB)} only — something in the page's own code failed.`,
          detail: items(f.detail, 4),
        });
        break;
      case 'network':
        out.push({
          level: f.severity,
          text: /third-party/i.test(t)
            ? `Files from an outside service failed to load on ${sideOf(t, labelA, labelB)} only.`
            : `The site's own files or API calls failed to load on ${sideOf(t, labelA, labelB)} only.`,
          detail: items(f.detail, 4),
        });
        break;
      case 'visual':
        out.push({ level: f.severity, text: `The page looks different — ${t.replace(/^Visual difference: /, '').replace(/ of pixels$/, '')} of the screen changed. Compare the two pictures below.`, detail: [] });
        break;
      case 'control':
        out.push({ level: f.severity, text: `Buttons differ: ${t.replace(/^Buttons \/ controls: /, '')}.`, detail: items(f.detail) });
        break;
      case 'heading':
        out.push({ level: f.severity, text: `Headings differ: ${t.replace(/^Headings: /, '')}.`, detail: items(f.detail) });
        break;
      case 'field':
        out.push({ level: f.severity, text: `Form fields differ: ${t.replace(/^Form fields: /, '')}.`, detail: items(f.detail) });
        break;
      case 'nav-item':
      case 'navItems':
      case 'nav_menu':
        out.push({ level: f.severity, text: t, detail: items(f.detail) });
        break;
      case 'tab':
        out.push({ level: f.severity, text: `Tabs differ: ${t.replace(/^Tabs: /, '')}.`, detail: items(f.detail) });
        break;
      case 'option':
        out.push({ level: f.severity, text: `Dropdown choices differ: ${t.replace(/^Dropdown options: /, '')}.`, detail: items(f.detail) });
        break;
      case 'card':
        out.push({ level: f.severity, text: `Cards/tiles differ: ${t.replace(/^Card titles: /, '')}.`, detail: items(f.detail) });
        break;
      case 'image':
        out.push({ level: f.severity, text: `Pictures differ: ${t.replace(/^Images: /, '')}.`, detail: items(f.detail) });
        break;
      case 'link':
        out.push({ level: f.severity, text: `Links differ: ${t.replace(/^Links: /, '')}.`, detail: items(f.detail, 4) });
        break;
      case 'icon':
        out.push({ level: f.severity, text: `Icons differ: ${t.replace(/^Icons: /, '')}.`, detail: items(f.detail, 4) });
        break;
      case 'census':
        out.push({ level: f.severity, text: 'Some parts of the page are present in different numbers on the two sites.', detail: items(f.detail, 10) });
        break;
      case 'copy':
        out.push({ level: f.severity, text: 'The wording on the page is not the same on both sites.', detail: items(f.detail, 8) });
        break;
      case 'title':
        out.push({ level: f.severity, text: 'The browser-tab title is different.', detail: items(f.detail, 2) });
        break;
      case 'lang':
        out.push({ level: f.severity, text: 'The default language of the page is different.', detail: [] });
        break;
      case 'redirect':
        out.push({ level: f.severity, text: 'One site sent the browser somewhere else, the other did not.', detail: items(f.detail, 2) });
        break;
      case 'perf':
        out.push({ level: f.severity, text: `${t}. Users on the slower side wait longer for this page.`, detail: items(f.detail, 1) });
        break;
      case 'build':
        out.push({ level: 'info', text: 'The two sites are running different versions of the website code — some differences below are simply "staging is ahead of (or behind) production".', detail: [] });
        break;
      default:
        out.push({ level: f.severity, text: t, detail: items(f.detail, 4) });
    }
  }
  return out;
}

/** Which environment a finding title is about ("… only on Staging"). */
function sideOf(title, labelA, labelB) {
  if (title.includes(labelB)) return labelB;
  if (title.includes(labelA)) return labelA;
  return 'one site';
}

// ══════════════════════════════════════════════════════════════════════
// TEXT
// ══════════════════════════════════════════════════════════════════════
/**
 * Pages whose two screenshots matched — the same thing each page panel says
 * with "both screens look the same".
 *
 * NOT the same as the "Identical" verdict: that means nothing differed on ANY
 * check, while a screen can look the same on a page whose element count, build
 * hash or timing differs. Without this, a reader counts three "look the same"
 * panels against an Identical card reading 0 and assumes the report is wrong.
 */
function screensMatched(routes) {
  return routes.filter((r) => !r.diffImage).length;
}

export function renderText(data) {
  const { labelA, labelB, urlA, urlB, routes, api, catalogue, startedAt, authNote, assetsDir } = data;
  const L = [];
  const line = (c = '=') => c.repeat(78);
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);

  L.push(line());
  L.push(`  ${labelA.toUpperCase()}  vs  ${labelB.toUpperCase()}`);
  L.push(line());
  L.push(`  ${labelA}: ${urlA}`);
  L.push(`  ${labelB}: ${urlB}`);
  L.push(`  Run on ${startedAt}`);
  L.push(`  ${authNote}`);
  L.push(`  Pages compared: ${routes.length}`);
  L.push('');
  L.push('  WHAT THE VERDICTS MEAN');
  L.push('    P1 BROKEN  the page does not work on one site: it failed to load, answered a');
  L.push('               different HTTP status, rendered blank, or a screen was unreachable.');
  L.push('               Fix before release.');
  L.push('    P2 MAJOR   the page works, but what a user sees or can do differs: a missing');
  L.push('               button or field, the portal\'s own API failing, an uncaught script');
  L.push('               error, or a large visual change (5%+ of pixels).');
  L.push('    P3 MINOR   cosmetic or expected drift: a small visual shift, different images');
  L.push('               or links, a different build hash, third-party widget noise.');
  L.push('    SAME       nothing differed');
  L.push('');
  L.push('  This tool opens each page on both sites at the same moment and compares what');
  L.push('  it sees. It does not fill in signups, finish courses or answer quizzes.');
  L.push('');

  let currentJourney = null;
  routes.forEach((r, i) => {
    if (r.route.journey && r.route.journey !== currentJourney) {
      const steps = routes.filter((x) => x.route.journey === r.route.journey);
      L.push('');
      L.push(line('#'));
      L.push(`  JOURNEY: ${r.route.journey.toUpperCase()} — ${steps.length} steps, walked on both sites together`);
      L.push(line('#'));
    }
    currentJourney = r.route.journey || null;
    L.push(line());
    L.push(`  PAGE ${i + 1} of ${routes.length}:  ${r.route.name}`);
    L.push(`  Address: ${r.route.path}${r.route.auth ? '   (signed in)' : ''}`);
    L.push(`  VERDICT: ${VERDICT[r.worst].text}`);
    if (r.route.note) L.push(`  What this page is: ${r.route.note}`);
    L.push(line('-'));
    L.push(`    ${pad('WHAT WE CHECKED', 40)}${pad(labelA.toUpperCase(), 20)}${labelB.toUpperCase()}`);
    for (const [what, a, b, differs] of rows(r.A, r.B)) {
      const isDiff = differs === undefined ? String(a) !== String(b) : differs;
      L.push(`  ${isDiff ? '*' : ' '} ${pad(what, 40)}${pad(a, 20)}${b}`);
    }
    L.push('    (rows marked * are where the two sites differ)');
    const steps = r.A?.stepsRun?.length ? r.A.stepsRun : r.B?.stepsRun || [];
    if (steps.length) {
      L.push('');
      L.push('  Steps walked before comparing:');
      steps.forEach((s, n) => L.push(`    ${n + 1}. ${s.label}${s.ok ? '' : '  ← FAILED: ' + s.error}`));
    }
    const diffs = plainDifferences(r, labelA, labelB);
    L.push('');
    if (!diffs.length) {
      L.push('  WHAT IS DIFFERENT:  nothing — the two sites matched on every check.');
    } else {
      L.push('  WHAT IS DIFFERENT:');
      for (const d of diffs) {
        L.push(`    • ${d.text}`);
        for (const item of d.detail) L.push(`        - ${item}`);
      }
    }
    L.push('');
    L.push('  Pictures:');
    L.push(`    ${labelA}: ${assetsDir}/${r.A?.shots?.viewport || '(none)'}`);
    L.push(`    ${labelB}: ${assetsDir}/${r.B?.shots?.viewport || '(none)'}`);
    if (r.diffImage) L.push(`    Differences highlighted: ${assetsDir}/${r.diffImage}`);
    L.push('');
  });

  if (api.length) {
    L.push(line());
    L.push('  DATA CHECKS (the site\'s own services, asked the same question)');
    L.push(line('-'));
    L.push(`  ${pad('WHAT WE ASKED', 30)}${pad(labelA.toUpperCase(), 24)}${labelB.toUpperCase()}`);
    for (const r of api) {
      L.push(`  ${pad(r.a.name, 30)}${pad(`${r.a.status}, ${r.a.count ?? '—'} records`, 24)}${r.b.status}, ${r.b.count ?? '—'} records`);
    }
    L.push('');
  }

  if (catalogue) {
    L.push(line());
    L.push('  COURSES AVAILABLE');
    L.push(line('-'));
    L.push(`  ${pad('Total published courses', 38)}${pad(catalogue.totalA, 20)}${catalogue.totalB}`);
    L.push(`  ${pad('Courses only on ' + labelA, 38)}${catalogue.onlyA.length}`);
    L.push(`  ${pad('Courses only on ' + labelB, 38)}${catalogue.onlyB.length}`);
    if (catalogue.onlyA.length) {
      L.push('');
      L.push(`  Only on ${labelA}:`);
      catalogue.onlyA.slice(0, 40).forEach((n) => L.push(`    - ${n}`));
      if (catalogue.onlyA.length > 40) L.push(`    … and ${catalogue.onlyA.length - 40} more`);
    }
    if (catalogue.onlyB.length) {
      L.push('');
      L.push(`  Only on ${labelB}:`);
      catalogue.onlyB.slice(0, 40).forEach((n) => L.push(`    - ${n}`));
      if (catalogue.onlyB.length > 40) L.push(`    … and ${catalogue.onlyB.length - 40} more`);
    }
    L.push('');
  }

  if ((data.skippedWrites || []).length) {
    L.push(line());
    L.push('  STEPS THAT WERE NOT PERFORMED');
    L.push(line('-'));
    L.push('  These create real data (send an OTP, submit a signup), so they were skipped.');
    L.push('  Add --allow-writes to the command to include them.');
    for (const s of data.skippedWrites) L.push(`    ${s.journey}: ${s.steps.join(', ')}`);
    L.push('');
  }

  const counts = routes.reduce((m, r) => ({ ...m, [r.worst]: (m[r.worst] || 0) + 1 }), {});
  L.push(line());
  L.push('  SUMMARY');
  L.push(line('-'));
  L.push(`  P1 broken       : ${counts.error || 0}`);
  L.push(`  To check        : ${counts.warn || 0}`);
  L.push(`  Minor drift     : ${counts.info || 0}`);
  L.push(`  Identical       : ${counts.same || 0}`);
  L.push(`  Screens matched : ${screensMatched(routes)} of ${routes.length}  (pictures the same; a page can still differ on other checks)`);
  L.push(line());
  return L.join('\n');
}

// ══════════════════════════════════════════════════════════════════════
// HTML
// ══════════════════════════════════════════════════════════════════════
function pageBlock(r, i, total, assetsDir, labelA, labelB) {
  const v = VERDICT[r.worst];
  const diffs = plainDifferences(r, labelA, labelB);
  const steps = r.A?.stepsRun?.length ? r.A.stepsRun : r.B?.stepsRun || [];
  const shot = (cap, label) =>
    cap?.shots?.viewport
      ? `<a href="${esc(assetsDir)}/${esc(cap.shots.viewport)}" target="_blank"><img src="${esc(assetsDir)}/${esc(cap.shots.viewport)}" alt="${esc(label)}" loading="lazy" /></a>
         ${cap.shots.full ? `<div class="fp"><a href="${esc(assetsDir)}/${esc(cap.shots.full)}" target="_blank">see the whole page ▸</a></div>` : ''}`
      : '<div class="none">no picture</div>';

  return `<section class="page ${r.worst}">
    <h2>${i + 1}. ${esc(r.route.name)} <span class="verdict ${v.cls}">${esc(v.text)}</span></h2>
    <p class="where">Address: <code>${esc(r.route.path)}</code>${r.route.auth ? ' · signed in' : ''}${r.route.note ? ' — ' + esc(r.route.note) : ''}</p>

    ${steps.length ? `<p class="where">Steps walked first: ${steps.map((s) => `<span class="${s.ok ? 'ok' : 'bad'}">${esc(s.label)}${s.ok ? '' : ' (failed)'}</span>`).join(' → ')}</p>` : ''}

    <table class="cmp">
      <thead><tr><th>What we checked</th><th>${esc(labelA)}</th><th>${esc(labelB)}</th></tr></thead>
      <tbody>
        ${rows(r.A, r.B)
          .map(([what, a, b, differs]) => {
            const isDiff = differs === undefined ? String(a) !== String(b) : differs;
            return `<tr class="${isDiff ? 'differs' : ''}"><td>${esc(what)}</td><td>${esc(a)}</td><td>${esc(b)}</td></tr>`;
          })
          .join('\n')}
      </tbody>
    </table>

    <div class="shots">
      <div><h3>${esc(labelA)}</h3>${shot(r.A, labelA)}</div>
      <div><h3>${esc(labelB)}</h3>${shot(r.B, labelB)}</div>
      <div><h3>Differences highlighted</h3>${
        r.diffImage
          ? `<a href="${esc(assetsDir)}/${esc(r.diffImage)}" target="_blank"><img src="${esc(assetsDir)}/${esc(r.diffImage)}" alt="differences" loading="lazy" /></a><div class="fp">pink = changed</div>`
          : '<div class="none ok">both screens look the same</div>'
      }</div>
    </div>

    <div class="diffs">
      <h3>What is different</h3>
      ${diffs.length
        ? `<ul>${diffs.map((d) => `<li class="${d.level}">${esc(d.text)}${d.detail.length ? `<ul class="sub">${d.detail.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ul>`
        : '<p class="ok">Nothing — the two sites matched on every check.</p>'}
    </div>
  </section>`;
}

/**
 * Journey steps are printed under one heading, in order, so a flow reads as a
 * flow. Standalone pages are printed as they come.
 */
function renderGrouped(routes, assetsDir, labelA, labelB) {
  const out = [];
  let current = null;
  routes.forEach((r, i) => {
    const j = r.route.journey;
    if (j !== current) {
      if (current) out.push('</div>');
      if (j) {
        const steps = routes.filter((x) => x.route.journey === j);
        const worst = steps.some((s) => s.worst === 'error') ? 'error' : steps.some((s) => s.worst === 'warn') ? 'warn' : 'ok';
        out.push(`<div class="journey ${worst}">
          <h2 class="j-head">Journey: ${esc(j)} <span class="j-sub">${steps.length} steps, compared one by one on both sites</span></h2>`);
      }
      current = j;
    }
    out.push(pageBlock(r, i, routes.length, assetsDir, labelA, labelB));
  });
  if (current) out.push('</div>');
  return out.join('\n');
}

export function renderSimpleHtml(data) {
  const { labelA, labelB, urlA, urlB, routes, api, catalogue, assetsDir, startedAt, authNote } = data;
  const counts = routes.reduce((m, r) => ({ ...m, [r.worst]: (m[r.worst] || 0) + 1 }), {});

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(labelA)} vs ${esc(labelB)} — simple report</title>
<style>
  :root{--navy:#17283C;--teal:#1E8F8E;--gold:#F0A500;--gold-50:#FEF6E0;--gold-700:#9A6800;
    --grey:#F6F7F9;--line:#D8DEE5;--mid:#7C8696;--ink:#0D1218;
    --ok:#15803D;--ok-bg:#DCFCE7;--bad:#B91C1C;--bad-bg:#FEE2E2;--warn:#B45309;--warn-bg:#FEF3C7}
  *{box-sizing:border-box}
  body{margin:0;background:var(--grey);color:var(--ink);font:16px/1.65 'Segoe UI',system-ui,sans-serif}
  .wrap{max-width:1200px;margin:0 auto;padding:24px}
  header{background:var(--navy);color:#fff;padding:28px;border-radius:8px;border-bottom:4px solid var(--teal)}
  header h1{margin:0 0 6px;font-size:26px}
  header p{margin:2px 0;color:#C7CED7;font-size:14px}
  .totals{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}
  .tot{background:#fff;border:1px solid var(--line);border-radius:8px;padding:14px 20px;min-width:150px}
  .tot b{display:block;font-size:26px;color:var(--navy)}
  .tot span{font-size:13px;color:var(--mid)}
  .tot.bad b{color:var(--bad)} .tot.warn b{color:var(--warn)} .tot.ok b{color:var(--ok)}
  .howto{background:#fff;border:1px solid var(--line);border-radius:8px;padding:18px 22px;margin-bottom:20px}
  .howto h2{margin:0 0 8px;font-size:18px;color:var(--navy)}
  .howto dl{margin:0;display:grid;grid-template-columns:190px 1fr;gap:6px 14px;font-size:14px}
  .howto dt{font-weight:700}
  .howto .scope{margin:14px 0 0;font-size:14px;color:var(--mid)}
  section.page{background:#fff;border:1px solid var(--line);border-left:5px solid var(--line);border-radius:8px;padding:22px;margin:18px 0}
  section.page.error{border-left-color:var(--bad)} section.page.warn{border-left-color:var(--warn)}
  section.page.info{border-left-color:var(--teal)} section.page.same{border-left-color:var(--ok)}
  section.page h2{margin:0 0 4px;font-size:20px;color:var(--navy)}
  .verdict{font-size:13px;font-weight:700;padding:3px 12px;border-radius:9999px;vertical-align:middle;margin-left:6px}
  .verdict.bad{background:var(--bad-bg);color:var(--bad)} .verdict.warn{background:var(--warn-bg);color:var(--warn)}
  .verdict.info{background:#E3F7F6;color:var(--navy)} .verdict.ok{background:var(--ok-bg);color:var(--ok)}
  .where{color:var(--mid);font-size:14px;margin:2px 0 12px}
  .where .ok{color:var(--ok)} .where .bad{color:var(--bad);font-weight:700}
  table.cmp{width:100%;border-collapse:collapse;margin:12px 0 20px;font-size:15px}
  table.cmp th{background:var(--navy);color:#fff;text-align:left;padding:10px 12px;font-size:14px}
  table.cmp th:nth-child(2),table.cmp th:nth-child(3){width:24%}
  table.cmp td{border-top:1px solid var(--line);padding:9px 12px}
  table.cmp tr:nth-child(even) td{background:var(--grey)}
  table.cmp tr.differs td{background:var(--gold-50)}
  table.cmp tr.differs td:first-child{font-weight:700;color:var(--gold-700)}
  .shots{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:18px}
  .shots h3{margin:0 0 6px;font-size:14px;color:var(--navy);text-transform:uppercase;letter-spacing:.04em}
  .shots img{width:100%;height:auto;border:1px solid var(--line);border-radius:6px;display:block}
  .fp{font-size:12px;color:var(--mid);margin-top:4px}
  .none{padding:28px;text-align:center;color:var(--mid);border:1px dashed var(--line);border-radius:6px;font-size:14px}
  .none.ok{color:var(--ok);border-color:#BEE7CC;background:#F7FFFA}
  .diffs h3{margin:0 0 6px;font-size:14px;color:var(--navy);text-transform:uppercase;letter-spacing:.04em}
  .diffs ul{margin:0;padding-left:20px}
  .diffs > ul > li{margin:6px 0}
  .diffs li.error{color:var(--bad);font-weight:600}
  .diffs ul.sub{margin:4px 0 8px;padding-left:18px;color:var(--mid);font-size:13px;font-weight:400}
  .diffs .ok{color:var(--ok);font-weight:600}
  table.simple{width:100%;border-collapse:collapse;background:#fff;font-size:15px}
  table.simple th{background:var(--navy);color:#fff;text-align:left;padding:10px 12px;font-size:14px}
  table.simple td{border-top:1px solid var(--line);padding:9px 12px}
  .panel{background:#fff;border:1px solid var(--line);border-radius:8px;padding:20px;margin:18px 0}
  .panel h2{margin:0 0 10px;font-size:18px;color:var(--navy)}
  .panel ul{max-height:260px;overflow:auto;margin:6px 0 0}
  .journey{border:2px solid var(--teal);border-radius:10px;padding:6px 14px 14px;margin:22px 0;background:#EEF7F7}
  .journey.error{border-color:var(--bad)} .journey.warn{border-color:var(--gold)}
  .j-head{margin:12px 4px;font-size:20px;color:var(--navy)}
  .j-sub{display:block;font-size:13px;font-weight:400;color:var(--mid)}
  .journey section.page{page-break-inside:avoid}
  footer{color:var(--mid);font-size:13px;text-align:center;padding:20px}
  @media print{
    /* The PDF is printed with media:print, so THESE rules are what it uses.
       Keep the colours (verdict badges and highlight rows carry the meaning). */
    *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    body{background:#fff}
    .wrap{max-width:none;padding:0 6mm}
    section.page{page-break-inside:avoid;break-inside:avoid}
    .journey{break-inside:auto}
    .shots{grid-template-columns:1fr 1fr}
    .shots img{max-height:300px;object-fit:contain;object-position:top}
    /* Keep a heading with the table it introduces. */
    h2,h3{break-after:avoid}
    table{break-inside:auto}
    tr{break-inside:avoid}
    a{text-decoration:none;color:inherit}
  }
  @media (max-width:900px){.shots{grid-template-columns:1fr}.howto dl{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${esc(labelA)} vs ${esc(labelB)} — what is different</h1>
    <p>${esc(labelA)}: ${esc(urlA)}</p>
    <p>${esc(labelB)}: ${esc(urlB)}</p>
    <p>${esc(startedAt)} · ${esc(authNote)} · ${routes.length} pages compared</p>
  </header>

  <div class="totals">
    <div class="tot bad"><b>${counts.error || 0}</b><span>P1 broken</span></div>
    <div class="tot warn"><b>${counts.warn || 0}</b><span>To check</span></div>
    <div class="tot"><b>${counts.info || 0}</b><span>Minor drift</span></div>
    <div class="tot ok"><b>${counts.same || 0}</b><span>Identical</span></div>
    <div class="tot ok"><b>${screensMatched(routes)}</b><span>Screens matched</span></div>
  </div>

  <div class="howto">
    <h2>How to read this</h2>
    <dl>
      <dt>P1 BROKEN — does not work on one side</dt><dd>The page failed to load, answered a different HTTP status, rendered blank, or a screen could not be reached at all. Fix before release. A page that works but looks slightly different is <em>not</em> this.</dd>
      <dt>P2 MAJOR — a real difference to check</dt><dd>The page works, but what a user sees or can do differs: a missing button or field, one of the portal's own API calls failing, an uncaught script error, or a large visual change (5% or more of the pixels). Look at the two pictures and decide whether it was intended.</dd>
      <dt>P3 MINOR — cosmetic or expected drift</dt><dd>A small visual shift, different images or links, a different code version, or a third-party widget misbehaving. Worth a glance, not a release blocker.</dd>
      <dt>SAME ON BOTH</dt><dd>Nothing differed on any check.</dd>
      <dt>SCREENS MATCHED</dt><dd>How many pages showed <b>both screens look the same</b> — the two pictures matched. Counted separately from the verdicts above, because a page can look identical and still differ on something invisible, such as the element count or the build version. That is why a page can be "to check" and have matching screens at the same time.</dd>
    </dl>
    <p class="scope">Each page was opened on both sites at the same moment, and everything visible on it was compared —
      buttons, headings, fields, menus, tabs, pictures, wording and speed. Rows highlighted in yellow are the ones where the
      two sites gave different answers. This tool does not fill in signup forms, finish courses or answer quizzes.</p>
  </div>

  ${renderGrouped(routes, assetsDir, labelA, labelB)}

  ${(data.skippedWrites || []).length
      ? `<div class="panel"><h2>Steps that were not performed</h2>
      <p>These steps create real data (send an OTP, submit a signup), so they were skipped.
         Add <code>--allow-writes</code> to the command to include them.</p>
      <ul>${data.skippedWrites.map((s) => `<li><strong>${esc(s.journey)}</strong>: ${s.steps.map(esc).join(', ')}</li>`).join('')}</ul></div>`
      : ''}

  ${api.length
      ? `<div class="panel"><h2>Data checks</h2>
      <p>The same question asked to each site's own service.</p>
      <table class="simple"><thead><tr><th>What we asked</th><th>${esc(labelA)}</th><th>${esc(labelB)}</th></tr></thead>
      <tbody>${api.map((r) => `<tr><td>${esc(r.a.name)}</td><td>${r.a.status}, ${r.a.count ?? '—'} records</td><td>${r.b.status}, ${r.b.count ?? '—'} records</td></tr>`).join('')}</tbody></table></div>`
      : ''}

  ${catalogue
      ? `<div class="panel"><h2>Courses available</h2>
      <table class="simple"><thead><tr><th></th><th>${esc(labelA)}</th><th>${esc(labelB)}</th></tr></thead>
        <tbody><tr><td>Published courses</td><td>${catalogue.totalA}</td><td>${catalogue.totalB}</td></tr></tbody></table>
      <p><strong>${catalogue.onlyA.length}</strong> course(s) exist only on ${esc(labelA)}, <strong>${catalogue.onlyB.length}</strong> only on ${esc(labelB)}.</p>
      ${catalogue.onlyA.length ? `<p>Only on ${esc(labelA)}:</p><ul>${catalogue.onlyA.slice(0, 60).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      ${catalogue.onlyB.length ? `<p>Only on ${esc(labelB)}:</p><ul>${catalogue.onlyB.slice(0, 60).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      </div>`
      : ''}

  <footer>Made by <code>npm run compare</code> · Ekshamata automation</footer>
</div>
</body>
</html>`;
}
