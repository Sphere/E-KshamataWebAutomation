/**
 * Capture one page's "signature" on one environment — everything the
 * production-vs-staging comparison needs to spot a UI or functional drift:
 * status, timings, console errors, failed requests, the visible feature
 * surface (headings, nav, buttons, fields, images) and screenshots.
 *
 * Pure data in, pure data out — the diffing lives in env-diff.mjs.
 */

/** Collapse whitespace so two environments' text compares cleanly. */
export const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Resolve a step target: a css/xpath selector if it is one AND matches
 * something on the page, otherwise a button name or visible text — so steps can
 * read like the screen ("English", "Next") or be as precise as
 * `input[formcontrolname=firstName], input[name=email]`.
 */
async function locate(page, target) {
  if (/^(css=|xpath=|\/\/)/.test(target)) {
    return page.locator(target.replace(/^css=/, '')).first();
  }
  // Anything with selector punctuation is tried as a selector first; if it
  // matches nothing we fall through and treat it as text.
  if (/[[\].#>]/.test(target)) {
    try {
      const byCss = page.locator(target);
      if (await byCss.count()) return byCss.first();
    } catch (e) {
      /* not a valid selector — treat it as text */
    }
  }
  // "re=..." is taken as a PATTERN rather than literal text, so one step can
  // match a label in either language — the portal renders Hindi for most orgs
  // and a per-language step list would stop at the first one that misses.
  const re = target.startsWith('re=')
    ? new RegExp(target.slice(3), 'i')
    : new RegExp(escapeRe(target), 'i');
  // A tab is not a button: My Courses' "For You" / "आपके लिए" is role=tab, and
  // matching only buttons and raw text clicked the wrong node (or nothing).
  return page.getByRole('tab', { name: re })
    .or(page.getByRole('button', { name: re }))
    .or(page.getByText(re))
    .first();
}

/**
 * Walk a route's `steps` so the capture lands on the screen you actually mean —
 * a wizard's second page, a tab, an expanded panel. Each step is
 *   { "click": "English" } · { "fill": "input[name=x]", "value": "…" } ·
 *   { "waitFor": "Personal details" } · { "wait": 1200 }
 * Every step is recorded so the report can show what was walked, and so a step
 * that works on one environment but not the other becomes a finding.
 */
export async function runSteps(page, steps) {
  const done = [];
  for (const step of steps) {
    const label = step.click
      ? `click "${step.click}"`
      : step.fill
        ? `fill ${step.fill}`
        : step.waitFor
          ? `wait for "${step.waitFor}"`
          : `wait ${step.wait} ms`;
    try {
      if (step.click) {
        await (await locate(page, step.click)).click({ timeout: step.timeout ?? 15000 });
      } else if (step.fill) {
        await (await locate(page, step.fill)).fill(String(step.value ?? ''), { timeout: step.timeout ?? 15000 });
      } else if (step.waitFor) {
        await (await locate(page, step.waitFor)).waitFor({ state: 'visible', timeout: step.timeout ?? 15000 });
      }
      if (step.wait) await page.waitForTimeout(step.wait);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      done.push({ label, ok: true });
    } catch (e) {
      done.push({ label, ok: false, error: norm(e.message).slice(0, 200) });
      break; // later steps assume this one landed
    }
  }
  return done;
}

/**
 * Everything we read out of the DOM, in ONE evaluate() so both environments
 * are sampled exactly the same way. Runs inside the browser.
 */
function readPage() {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  };
  const txt = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const take = (sel, fn, cap = 120) =>
    [...document.querySelectorAll(sel)].filter(vis).map(fn).filter(Boolean).slice(0, cap);

  const headings = take('h1, h2, h3', (el) => el.tagName.toLowerCase() + ': ' + txt(el));
  const buttons = take('button, [role="button"], a.btn, input[type="submit"]', (el) =>
    txt(el) || el.getAttribute('aria-label') || el.getAttribute('title') || '');
  const links = take('a[href]', (el) => {
    const label = txt(el) || el.getAttribute('aria-label') || '';
    let href = el.getAttribute('href') || '';
    try { href = new URL(href, location.href).pathname; } catch (e) { /* leave as-is */ }
    return label || href ? label + ' -> ' + href : '';
  }, 200);
  const fields = take('input, select, textarea', (el) => {
    const kind = el.tagName.toLowerCase() === 'input' ? (el.getAttribute('type') || 'text') : el.tagName.toLowerCase();
    const name = el.getAttribute('name') || el.getAttribute('formcontrolname') || el.getAttribute('id') || '';
    const ph = el.getAttribute('placeholder') || el.getAttribute('aria-label') || '';
    return kind + ':' + (name || ph || '(unnamed)');
  });
  const imgEls = [...document.querySelectorAll('img')].filter(vis);
  const broken = imgEls
    .filter((i) => i.complete && i.naturalWidth === 0)
    .map((i) => (i.getAttribute('src') || '').slice(0, 200));
  // alt text + file name: catches a swapped or dropped image even when the
  // layout is unchanged.
  const images = imgEls
    .map((i) => {
      const alt = (i.getAttribute('alt') || '').trim();
      const file = (i.getAttribute('src') || '').split('?')[0].split('/').pop() || '';
      return alt || file ? `${alt || '(no alt)'} | ${file}`.slice(0, 160) : '';
    })
    .filter(Boolean)
    .slice(0, 120);

  // The rest of the interactive surface: tabs, nav/menu entries, card titles
  // and dropdown options — the pieces a "is anything missing?" check needs.
  const tabs = take('[role="tab"], mat-tab-header .mat-mdc-tab, .nav-tabs a, .tab', (el) => txt(el), 60);
  const navItems = take('nav a, nav button, [role="menuitem"], mat-sidenav a, header a', (el) => txt(el), 80);
  const cardTitles = take(
    'mat-card, .card, [class*="card"]',
    (el) => {
      const head = el.querySelector('h1,h2,h3,h4,h5,.title,[class*="title"]');
      return head ? txt(head) : '';
    },
    80,
  );
  const options = take('select option', (el) => txt(el), 80);
  const icons = take('mat-icon, i[class*="icon"], [class*="material-icons"]', (el) =>
    txt(el) || el.getAttribute('fonticon') || el.getAttribute('class') || '', 80);

  // A census of every visible element by tag — the catch-all that flags
  // "staging is rendering 3 fewer list items here" even for markup we have no
  // named check for.
  const census = {};
  for (const el of [...document.querySelectorAll('body *')]) {
    if (!vis(el)) continue;
    const tag = el.tagName.toLowerCase();
    census[tag] = (census[tag] || 0) + 1;
  }

  // Angular fingerprints its bundles (main.<hash>.js) — a different hash means
  // the two environments are running different code.
  const bundles = [...document.querySelectorAll('script[src]')]
    .map((s) => (s.getAttribute('src') || '').split('/').pop())
    .filter((f) => /\.js$/i.test(f))
    .sort();

  const body = document.body ? txt(document.body) : '';

  return {
    title: document.title || '',
    lang: document.documentElement.getAttribute('lang') || '',
    headings,
    buttons: [...new Set(buttons)],
    links: [...new Set(links)],
    fields: [...new Set(fields)],
    tabs: [...new Set(tabs)],
    navItems: [...new Set(navItems)],
    cardTitles: [...new Set(cardTitles)],
    options: [...new Set(options)],
    icons: [...new Set(icons)],
    images,
    census,
    bundles,
    counts: {
      headings: document.querySelectorAll('h1,h2,h3').length,
      buttons: document.querySelectorAll('button,[role="button"]').length,
      links: document.querySelectorAll('a[href]').length,
      images: imgEls.length,
      brokenImages: broken.length,
      inputs: document.querySelectorAll('input,select,textarea').length,
      cards: document.querySelectorAll('mat-card, .card, [class*="card"]').length,
      elements: Object.values(census).reduce((n, c) => n + c, 0),
    },
    brokenImages: broken.slice(0, 20),
    // A trimmed body sample: enough to catch copy/label drift, small enough to
    // keep the JSON readable.
    text: body.slice(0, 20000),
    textLength: body.length,
    isBlank: body.length < 40,
  };
}

/**
 * Read the page exactly as it stands right now — no navigation. This is what a
 * journey uses at each checkpoint, and what capture() uses after loading.
 *
 * @param {import('playwright-core').Page} page
 * @param {{shotDir:string, prefix:string, id:string, fullPage?:boolean}} opts
 */
export async function snapshot(page, opts) {
  let dom = null;
  let error = '';
  try {
    dom = await page.evaluate(readPage);
  } catch (e) {
    error = 'could not read the DOM: ' + norm(e.message).slice(0, 200);
  }

  const shots = {};
  const shotBase = opts.prefix + '_' + opts.id;
  try {
    await page.screenshot({ path: opts.shotDir + '/' + shotBase + '_viewport.png' });
    shots.viewport = shotBase + '_viewport.png';
    if (opts.fullPage !== false) {
      await page.screenshot({ path: opts.shotDir + '/' + shotBase + '_full.png', fullPage: true });
      shots.full = shotBase + '_full.png';
    }
  } catch (e) {
    if (!error) error = 'screenshot failed: ' + norm(e.message).slice(0, 200);
  }

  return { shots, error, ...(dom ?? { unreadable: true }) };
}

/**
 * Load `route` on `page` and return its full signature.
 *
 * @param {import('playwright-core').Page} page
 * @param {{id:string,name:string,path:string,wait?:number}} route
 * @param {string} baseUrl
 * @param {{shotDir:string, prefix:string, fullPage?:boolean, settle?:number}} opts
 */
/**
 * Block until the visible DOM stops changing (or `timeoutMs` runs out).
 *
 * Counts visible elements, inputs and images, and waits for two consecutive
 * readings `quietMs` apart to match. Cheap, and it does not need to know what
 * any particular screen looks like.
 *
 * @returns {Promise<{stable: boolean, waitedMs: number}>}
 */
export async function waitForStableDom(page, { quietMs = 1000, timeoutMs = 15000 } = {}) {
  const sample = () => page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const all = Array.from(document.querySelectorAll('*')).filter(vis);
    const inputs = Array.from(document.querySelectorAll('input')).filter(vis);
    return [
      all.length,
      inputs.length,
      inputs.filter((i) => (i.value || '').trim().length > 0).length,
      Array.from(document.querySelectorAll('img')).filter(vis).length,
    ].join('/');
  }).catch(() => '');

  const started = Date.now();
  let previous = await sample();
  while (Date.now() - started < timeoutMs) {
    await page.waitForTimeout(quietMs);
    const current = await sample();
    if (current && current === previous) return { stable: true, waitedMs: Date.now() - started };
    previous = current;
  }
  return { stable: false, waitedMs: Date.now() - started };
}

export async function capture(page, route, baseUrl, opts) {
  const consoleErrors = [];
  const consoleWarnings = [];
  const failedRequests = [];
  const pageErrors = [];

  const onConsole = (msg) => {
    const t = msg.type();
    let text = norm(msg.text()).slice(0, 300);
    if (!text) return;
    // Chrome reports subresource failures as a bare "Failed to load resource";
    // the url only lives on the location, and without it the diff cannot tell
    // a broken portal call from a broken third-party widget.
    const where = msg.location()?.url || '';
    if (where && !text.includes('http')) text += ` (${where.slice(0, 200)})`;
    if (t === 'error') consoleErrors.push(text);
    else if (t === 'warning') consoleWarnings.push(text);
  };
  const onPageError = (err) => pageErrors.push(norm(err.message).slice(0, 300));
  // The environment's own host — anything else is a third-party asset, which
  // the diff grades more gently than a broken first-party call.
  const ownHost = safeHost(baseUrl);
  const describe = (u) => {
    const host = safeHost(u);
    return { url: shortUrl(u), host, thirdParty: Boolean(host) && host !== ownHost };
  };

  const onResponse = (res) => {
    const s = res.status();
    if (s >= 400) failedRequests.push({ status: String(s), ...describe(res.url()) });
  };
  const onRequestFailed = (req) => {
    const why = req.failure()?.errorText || 'failed';
    // Aborted navigations/preloads are noise, not defects.
    if (/ERR_ABORTED/i.test(why)) return;
    failedRequests.push({ status: why, ...describe(req.url()) });
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);

  const url = baseUrl + route.path;
  const started = Date.now();
  let status = 0;
  let navError = '';
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    status = resp?.status() ?? 0;
  } catch (e) {
    navError = norm(e.message).slice(0, 300);
  }
  const domReadyMs = Date.now() - started;
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  const idleMs = Date.now() - started;
  const settle = route.wait ?? opts.settle ?? 0;
  if (settle) await page.waitForTimeout(settle);

  // Wait until the page STOPS CHANGING, not just until the network went quiet.
  //
  // networkidle fires while Angular is still painting: the Account page reached
  // idle and was photographed with 1 form field where it eventually renders 4,
  // and the comparison reported it as content missing on staging when the page
  // was fine — it had simply not finished. Sample the visible DOM until two
  // readings agree, so both environments are photographed in the same state.
  await waitForStableDom(page, {
    quietMs: route.stableMs ?? opts.stableMs ?? 1000,
    timeoutMs: route.stableTimeout ?? opts.stableTimeout ?? 15000,
  });

  // Walk into the screen the route is really about (wizard step, tab, panel).
  const stepsRun = route.steps?.length ? await runSteps(page, route.steps) : [];

  // The viewport shot is the pixel-diff subject: identical dimensions on both
  // environments, so a diff there is a real visual change.
  const { shots, error, ...dom } = await snapshot(page, { ...opts, id: route.id });
  if (error && !navError) navError = error;

  page.off('console', onConsole);
  page.off('pageerror', onPageError);
  page.off('response', onResponse);
  page.off('requestfailed', onRequestFailed);

  return {
    routeId: route.id,
    url,
    finalUrl: page.url(),
    redirected: stripQuery(page.url()) !== stripQuery(url),
    status,
    navError,
    timings: { domReadyMs, idleMs },
    stepsRun,
    consoleErrors: dedupe(consoleErrors),
    consoleWarnings: dedupe(consoleWarnings),
    pageErrors: dedupe(pageErrors),
    failedRequests: dedupeBy(failedRequests, (r) => r.status + ' ' + r.host + r.url),
    ownHost,
    shots,
    ...dom,
  };
}

/** Call one API endpoint and describe the response (status, count, latency). */
export async function probeApi(origin, ep) {
  const started = Date.now();
  const out = { id: ep.id, name: ep.name, path: ep.path, status: 0, ms: 0, count: null, error: '' };
  try {
    const res = await fetch(origin + ep.path, {
      method: ep.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(ep.headers || {}) },
      ...(ep.body ? { body: JSON.stringify(ep.body) } : {}),
    });
    out.status = res.status;
    const body = await res.json().catch(() => null);
    if (body && ep.count) {
      out.count = ep.count.split('.').reduce((o, k) => (o == null ? o : o[k]), body) ?? null;
    }
  } catch (e) {
    out.error = norm(e.message).slice(0, 200);
  }
  out.ms = Date.now() - started;
  return out;
}

const dedupe = (a) => [...new Set(a)].slice(0, 25);
const dedupeBy = (a, key) => {
  const seen = new Set();
  return a
    .filter((x) => {
      const k = key(x);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 25);
};
const stripQuery = (u) => String(u).split('?')[0].replace(/\/+$/, '');
/** Path only, so failed requests read cleanly in the report. */
function shortUrl(u) {
  try {
    const x = new URL(u);
    return (x.pathname + x.search).slice(0, 160);
  } catch (e) {
    return String(u).slice(0, 160);
  }
}

function safeHost(u) {
  try {
    return new URL(u).hostname;
  } catch (e) {
    return '';
  }
}
