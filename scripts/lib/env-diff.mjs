/**
 * Turn two captures of the same route (env A vs env B) into a list of
 * findings — the actual "what is different" of the comparison.
 *
 * Severities:
 *   error — the feature is broken or missing on one environment
 *   warn  — a real difference a tester should look at (missing control, copy
 *           change, visual drift, console errors on one side only)
 *   info  — worth knowing, not necessarily wrong (different build, slower page)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Severity, and what each level MEANS. Reported as:
 *   error → "Broken"   the page does not work on one side: it failed to load,
 *                      answered a different HTTP status, rendered blank, or a
 *                      screen could not be reached at all.
 *   warn  → "Major"    the page works, but what a user can see or do differs:
 *                      a missing button or field, the portal's own API failing,
 *                      an uncaught script error, a large visual change.
 *   info  → "Minor"    cosmetic or content churn: a small visual difference,
 *                      different images or links, a different build hash,
 *                      third-party widget noise.
 *
 * A first-party console error used to be graded "Broken", so a page that was
 * pixel-for-pixel identical and fully usable was reported as broken. Something
 * being worth fixing is not the same as the page being broken.
 */
const finding = (severity, kind, title, detail) => ({ severity, kind, title, detail });

/** Items present in `a` but not in `b`, compared case-insensitively. */
function missingFrom(a = [], b = []) {
  const have = new Set(b.map((x) => String(x).toLowerCase()));
  return a.filter((x) => !have.has(String(x).toLowerCase()));
}

/** Words/phrases that appear on one side only — catches copy and label drift. */
function sentenceDiff(textA = '', textB = '') {
  const split = (t) =>
    t.split(/(?<=[.!?])\s+|\s{2,}|\n+/)
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 12 && s.length < 200);
  const A = split(textA);
  const B = split(textB);
  const setB = new Set(B.map((s) => s.toLowerCase()));
  const setA = new Set(A.map((s) => s.toLowerCase()));
  return {
    onlyA: [...new Set(A.filter((s) => !setB.has(s.toLowerCase())))].slice(0, 12),
    onlyB: [...new Set(B.filter((s) => !setA.has(s.toLowerCase())))].slice(0, 12),
  };
}

/**
 * Compare two same-size PNGs pixel by pixel.
 * Returns { percent, diffPixels, width, height, wrote } — and writes a diff
 * image (changed pixels in magenta over a dimmed base) when `outPath` is given.
 * Different-sized shots are reported as a size mismatch instead.
 */
export function pixelDiff(pathA, pathB, outPath, { tolerance = 24, minPercent = 0 } = {}) {
  let PNG;
  try {
    ({ PNG } = require('playwright-core/lib/utilsBundle'));
  } catch (e) {
    return { unavailable: true, reason: 'PNG codec not available' };
  }
  let a;
  let b;
  try {
    a = PNG.sync.read(readFileSync(pathA));
    b = PNG.sync.read(readFileSync(pathB));
  } catch (e) {
    return { unavailable: true, reason: String(e.message).slice(0, 120) };
  }
  if (a.width !== b.width || a.height !== b.height) {
    return { sizeMismatch: true, a: { w: a.width, h: a.height }, b: { w: b.width, h: b.height } };
  }

  const out = new PNG({ width: a.width, height: a.height });
  let diffPixels = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const dr = Math.abs(a.data[i] - b.data[i]);
    const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
    const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
    const changed = dr + dg + db > tolerance;
    if (changed) {
      diffPixels++;
      out.data[i] = 255; out.data[i + 1] = 0; out.data[i + 2] = 170; out.data[i + 3] = 255;
    } else {
      // Dim the unchanged base so the magenta pops.
      const grey = (a.data[i] + a.data[i + 1] + a.data[i + 2]) / 3;
      const soft = 200 + grey * 0.2;
      out.data[i] = soft; out.data[i + 1] = soft; out.data[i + 2] = soft; out.data[i + 3] = 255;
    }
  }
  const percent = (diffPixels / (a.width * a.height)) * 100;
  let wrote = false;
  // Only keep a diff image worth looking at — below the threshold the two
  // environments are visually the same and the file is just clutter.
  if (outPath && diffPixels && percent >= minPercent) {
    writeFileSync(outPath, PNG.sync.write(out));
    wrote = true;
  }
  return { percent, diffPixels, width: a.width, height: a.height, wrote };
}

/**
 * Diff one route across the two environments.
 *
 * @param {object} route   the inventory entry
 * @param {object} A       capture from env A (production by default)
 * @param {object} B       capture from env B (staging by default)
 * @param {{labelA:string, labelB:string, pixelThreshold?:number, slowFactor?:number}} opts
 */
export function diffRoute(route, A, B, opts) {
  const { labelA, labelB, pixelThreshold = 0.5, slowFactor = 2 } = opts;
  const findings = [];

  // Chrome's "the machine's own connection went away" errors. When they show up
  // on BOTH sides it is the run that broke, not either environment.
  const LOCAL_NET = /ERR_NETWORK_CHANGED|ERR_NETWORK_IO_SUSPENDED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_RESET|ERR_TIMED_OUT|ERR_NAME_NOT_RESOLVED/i;
  const netCode = (s) => (String(s).match(LOCAL_NET) || [''])[0].toUpperCase();
  const bothSidesHit = (code) =>
    code &&
    (A.failedRequests || []).some((r) => netCode(r.status) === code) &&
    (B.failedRequests || []).some((r) => netCode(r.status) === code);

  // ── reachability ────────────────────────────────────────────────
  if (A.navError && B.navError) {
    findings.push(finding('warn', 'nav', 'Neither environment loaded — check the machine running this',
      `${labelA}: ${A.navError}\n${labelB}: ${B.navError}\n` +
        'Both sides failing the same way usually means the run lost its own connection; re-run before filing this.'));
  } else {
    for (const [cap, label] of [[A, labelA], [B, labelB]]) {
      if (cap.navError) findings.push(finding('error', 'nav', `Page did not load on ${label}`, cap.navError));
    }
  }
  if (A.status !== B.status) {
    findings.push(finding('error', 'status', 'HTTP status differs',
      `${labelA}: ${A.status || 'no response'} · ${labelB}: ${B.status || 'no response'}`));
  }
  if (A.redirected !== B.redirected) {
    findings.push(finding('warn', 'redirect', 'One environment redirects, the other does not',
      `${labelA}: ${A.finalUrl} · ${labelB}: ${B.finalUrl}`));
  }
  // A configured step that lands on one environment but not the other is the
  // clearest functional difference this tool can find.
  const stepsA = A.stepsRun || [];
  const stepsB = B.stepsRun || [];
  for (let i = 0; i < Math.max(stepsA.length, stepsB.length); i++) {
    const a = stepsA[i];
    const b = stepsB[i];
    const label = a?.label || b?.label || `step ${i + 1}`;
    if (a?.ok && b && !b.ok) {
      findings.push(finding('error', 'step', `Step failed on ${labelB}: ${label}`, b.error || ''));
    } else if (b?.ok && a && !a.ok) {
      findings.push(finding('error', 'step', `Step failed on ${labelA}: ${label}`, a.error || ''));
    } else if (a && !a.ok && b && !b.ok) {
      findings.push(finding('warn', 'step', `Step failed on both environments: ${label}`,
        `${labelA}: ${a.error}\n${labelB}: ${b.error}\nThe step may need updating in config/compare-routes.json.`));
    } else if (!a || !b) {
      findings.push(finding('warn', 'step', `Step only ran on ${a ? labelA : labelB}: ${label}`, ''));
    }
  }

  if (A.isBlank !== B.isBlank) {
    const blank = A.isBlank ? labelA : labelB;
    findings.push(finding('error', 'blank', `Page renders blank on ${blank}`,
      `${labelA}: ${A.textLength ?? 0} chars · ${labelB}: ${B.textLength ?? 0} chars of visible text`));
  }

  // ── functional signals ──────────────────────────────────────────
  // Classify by the FIRST url in the message — that is the resource that
  // actually failed. ("Access to fetch at '<widget>' from origin '<portal>'"
  // is the widget breaking, not the portal.) No url at all = app-level error.
  const hosts = [A.ownHost, B.ownHost].filter(Boolean);
  const firstParty = (text) => {
    const url = String(text).match(/https?:\/\/[^\s'")\]]+/);
    if (!url) return true;
    try {
      return hosts.includes(new URL(url[0]).hostname);
    } catch (e) {
      return true;
    }
  };
  const consoleFinding = (rawList, label) => {
    const list = rawList.filter((t) => !bothSidesHit(netCode(t)));
    const own = list.filter(firstParty);
    const ext = list.filter((t) => !firstParty(t));
    if (own.length) {
      findings.push(finding('warn', 'console', `${own.length} console error(s) only on ${label}`, own.join('\n')));
    }
    if (ext.length) {
      findings.push(finding('info', 'console', `${ext.length} third-party console error(s) only on ${label}`, ext.join('\n')));
    }
  };
  consoleFinding(missingFrom(A.consoleErrors, B.consoleErrors), labelA);
  consoleFinding(missingFrom(B.consoleErrors, A.consoleErrors), labelB);
  const jsOnlyA = missingFrom(A.pageErrors, B.pageErrors);
  const jsOnlyB = missingFrom(B.pageErrors, A.pageErrors);
  if (jsOnlyA.length) findings.push(finding('warn', 'jserror', `Uncaught JS error only on ${labelA}`, jsOnlyA.join('\n')));
  if (jsOnlyB.length) findings.push(finding('warn', 'jserror', `Uncaught JS error only on ${labelB}`, jsOnlyB.join('\n')));

  // Failing requests: the portal's own endpoints are blocking, a third-party
  // script or CDN asset is only worth a look.
  const reqLine = (r) => `${r.status} ${r.thirdParty ? r.host : ''}${r.url}`;
  const failKeys = (caps) => new Set((caps || []).map(reqLine));
  const netFinding = (mine, theirs, label) => {
    const otherKeys = failKeys(theirs);
    const only = (mine || [])
      .filter((r) => !otherKeys.has(reqLine(r)))
      // Same connection error on both sides = the run's own network, and the
      // urls only differ because each environment serves its own bundles.
      .filter((r) => !bothSidesHit(netCode(r.status)));
    const own = only.filter((r) => !r.thirdParty);
    const ext = only.filter((r) => r.thirdParty);
    if (own.length) {
      findings.push(finding('warn', 'network', `${own.length} failing request(s) only on ${label}`, own.map(reqLine).join('\n')));
    }
    if (ext.length) {
      findings.push(finding('info', 'network', `${ext.length} third-party request(s) failing only on ${label}`, ext.map(reqLine).join('\n')));
    }
  };
  netFinding(A.failedRequests, B.failedRequests, labelA);
  netFinding(B.failedRequests, A.failedRequests, labelB);

  // ── feature surface (the "is anything missing" checks) ───────────
  const surfaces = [
    ['heading', 'Headings', A.headings, B.headings],
    ['control', 'Buttons / controls', A.buttons, B.buttons],
    ['field', 'Form fields', A.fields, B.fields],
    ['nav', 'Navigation / menu items', A.navItems, B.navItems],
    ['tab', 'Tabs', A.tabs, B.tabs],
    ['card', 'Card titles', A.cardTitles, B.cardTitles],
    ['option', 'Dropdown options', A.options, B.options],
    ['image', 'Images', A.images, B.images],
    ['icon', 'Icons', A.icons, B.icons],
    ['link', 'Links', A.links, B.links],
  ];
  // Links, icons and images churn with content (a different course tile is not
  // a defect), so they are informational; a missing control or menu entry is not.
  const soft = new Set(['link', 'icon', 'image', 'card']);
  for (const [kind, label, listA, listB] of surfaces) {
    const onlyA = missingFrom(listA, listB);
    const onlyB = missingFrom(listB, listA);
    const sev = soft.has(kind) ? 'info' : 'warn';
    if (onlyA.length) {
      findings.push(finding(sev, kind,
        `${label}: ${onlyA.length} on ${labelA} but not on ${labelB}`, onlyA.slice(0, 15).join('\n')));
    }
    if (onlyB.length) {
      findings.push(finding(sev, kind,
        `${label}: ${onlyB.length} on ${labelB} but not on ${labelA}`, onlyB.slice(0, 15).join('\n')));
    }
  }

  // Catch-all: every visible element, counted by tag. Flags markup we have no
  // named check for ("staging renders 4 fewer list items here").
  const censusA = A.census || {};
  const censusB = B.census || {};
  const tags = [...new Set([...Object.keys(censusA), ...Object.keys(censusB)])].sort();
  const censusRows = tags
    .map((t) => ({ tag: t, a: censusA[t] || 0, b: censusB[t] || 0 }))
    .filter((r) => r.a !== r.b);
  if (censusRows.length) {
    findings.push(finding('info', 'census', `Element census differs for ${censusRows.length} tag(s)`,
      [`tag${' '.repeat(14)}${labelA} / ${labelB}`,
        ...censusRows.slice(0, 25).map((r) => `${r.tag.padEnd(18)}${r.a} / ${r.b}`)].join('\n')));
  }

  if ((A.counts?.brokenImages ?? 0) !== (B.counts?.brokenImages ?? 0)) {
    findings.push(finding('warn', 'image', 'Broken images differ',
      `${labelA}: ${A.counts?.brokenImages ?? 0} · ${labelB}: ${B.counts?.brokenImages ?? 0}\n` +
        [...(A.brokenImages || []), ...(B.brokenImages || [])].slice(0, 8).join('\n')));
  }

  if (A.title !== B.title) {
    findings.push(finding('warn', 'title', 'Page title differs', `${labelA}: "${A.title}"\n${labelB}: "${B.title}"`));
  }
  if (A.lang !== B.lang) {
    findings.push(finding('warn', 'lang', 'Default language differs', `${labelA}: ${A.lang || '(unset)'} · ${labelB}: ${B.lang || '(unset)'}`));
  }

  // ── copy drift ──────────────────────────────────────────────────
  const copy = sentenceDiff(A.text, B.text);
  if (copy.onlyA.length || copy.onlyB.length) {
    findings.push(finding('info', 'copy', 'Page copy differs',
      [
        copy.onlyA.length ? `Only on ${labelA}:\n  ` + copy.onlyA.join('\n  ') : '',
        copy.onlyB.length ? `Only on ${labelB}:\n  ` + copy.onlyB.join('\n  ') : '',
      ].filter(Boolean).join('\n')));
  }

  // ── build + performance ─────────────────────────────────────────
  const bundlesA = (A.bundles || []).join(',');
  const bundlesB = (B.bundles || []).join(',');
  if (bundlesA && bundlesB && bundlesA !== bundlesB) {
    // CONTEXT, not a difference. Two environments always run different builds,
    // so counting this gave every page at least one finding — "Identical" could
    // never be anything but zero, and pages that look and behave the same were
    // filed under "Minor drift". Still reported; just not graded.
    findings.push({
      ...finding('info', 'build', 'Different front-end build',
        `${labelA}: ${(A.bundles || []).slice(0, 5).join(', ')}\n${labelB}: ${(B.bundles || []).slice(0, 5).join(', ')}`),
      context: true,
    });
  }
  const tA = A.timings?.idleMs ?? 0;
  const tB = B.timings?.idleMs ?? 0;
  if (tA && tB && Math.max(tA, tB) / Math.min(tA, tB) >= slowFactor) {
    const slower = tA > tB ? labelA : labelB;
    findings.push(finding('warn', 'perf', `${slower} is ${(Math.max(tA, tB) / Math.min(tA, tB)).toFixed(1)}x slower to settle`,
      `${labelA}: ${tA} ms · ${labelB}: ${tB} ms (navigation → network idle)`));
  }

  // ── visual ──────────────────────────────────────────────────────
  const px = opts.pixel;
  if (px && px.sizeMismatch) {
    findings.push(finding('warn', 'visual', 'Screenshots have different dimensions',
      `${labelA}: ${px.a.w}x${px.a.h} · ${labelB}: ${px.b.w}x${px.b.h}`));
  } else if (px && !px.unavailable && px.percent >= pixelThreshold) {
    // A couple of percent is a nudged margin or a different image; double digits
    // is a different layout. Grade them differently instead of calling both the
    // same thing.
    const major = px.percent >= (opts.majorPixelPercent ?? 5);
    findings.push(finding(major ? 'warn' : 'info', 'visual',
      `Visual difference: ${px.percent.toFixed(2)}% of pixels`,
      `${px.diffPixels.toLocaleString()} of ${(px.width * px.height).toLocaleString()} pixels differ in the ${px.width}x${px.height} viewport shot.`
      + (major ? '' : ' Small enough to be spacing or a swapped image rather than a layout change.')));
  }

  // Context findings are reported but do not set the verdict.
  const graded = findings.filter((f) => !f.context);
  const worst = graded.some((f) => f.severity === 'error')
    ? 'error'
    : graded.some((f) => f.severity === 'warn')
      ? 'warn'
      : graded.length
        ? 'info'
        : 'same';

  return { route, A, B, findings, worst, pixel: px ?? null };
}

/** Compare the API probes for one endpoint across both environments. */
export function diffApi(a, b, labelA, labelB) {
  const findings = [];
  if (a.error || b.error) {
    findings.push(finding('error', 'api', 'Endpoint call failed',
      `${labelA}: ${a.error || 'ok'} · ${labelB}: ${b.error || 'ok'}`));
  }
  if (a.status !== b.status) {
    findings.push(finding('error', 'api', 'HTTP status differs', `${labelA}: ${a.status} · ${labelB}: ${b.status}`));
    // (kept at error: an endpoint answering differently IS the endpoint broken)
  }
  if (a.count != null && b.count != null && a.count !== b.count) {
    findings.push(finding('info', 'api', 'Record count differs', `${labelA}: ${a.count} · ${labelB}: ${b.count}`));
  }
  const worst = findings.some((f) => f.severity === 'error') ? 'error' : findings.length ? 'info' : 'same';
  return { a, b, findings, worst };
}

/**
 * Which courses live on one environment but not the other. Content parity is
 * the most common "it works on prod but not on staging" cause.
 */
export function diffCatalogue(coursesA, coursesB, labelA, labelB) {
  const namesA = coursesA.map((c) => c.name);
  const namesB = coursesB.map((c) => c.name);
  const onlyA = missingFrom(namesA, namesB);
  const onlyB = missingFrom(namesB, namesA);
  return {
    totalA: namesA.length,
    totalB: namesB.length,
    onlyA,
    onlyB,
    labelA,
    labelB,
    worst: onlyA.length || onlyB.length ? 'info' : 'same',
  };
}
