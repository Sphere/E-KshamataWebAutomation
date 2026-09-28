/**
 * A JOURNEY is a flow walked on both environments in lockstep — create an
 * account, log in, open a course — with a comparison taken at EVERY step.
 *
 * Both environments perform the same action at the same moment, then both are
 * photographed and compared before the next action. So instead of "the signup
 * page differs", you get "step 3 of signup differs, here are the two pictures".
 *
 * Journeys live in config/compare-journeys.json. A step is:
 *   {
 *     "label": "Choose English",
 *     "do": [ { "click": "English" }, { "click": "Next" } ],   // omitted on the first step
 *     "wait": 1200,                                            // settle before the photo
 *     "writes": true                                           // needs --allow-writes
 *   }
 *
 * Anything that would create real data (submitting a signup, sending an OTP)
 * must be marked `writes: true`; those steps are skipped unless the run was
 * started with --allow-writes, so a routine comparison never registers a user
 * on production.
 */
import { runSteps, snapshot, norm } from './env-capture.mjs';

/** Listeners that collect console/network problems for one step. */
function watch(page, ownHost) {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const describe = (u) => {
    let host = '';
    try { host = new URL(u).hostname; } catch (e) { /* keep empty */ }
    let path = u;
    try { const x = new URL(u); path = (x.pathname + x.search).slice(0, 160); } catch (e) { /* keep raw */ }
    return { url: path, host, thirdParty: Boolean(host) && host !== ownHost };
  };

  const onConsole = (m) => {
    if (m.type() !== 'error') return;
    let t = norm(m.text()).slice(0, 300);
    const where = m.location()?.url || '';
    if (t && where && !t.includes('http')) t += ` (${where.slice(0, 200)})`;
    if (t) consoleErrors.push(t);
  };
  const onPageError = (e) => pageErrors.push(norm(e.message).slice(0, 300));
  const onResponse = (r) => { if (r.status() >= 400) failedRequests.push({ status: String(r.status()), ...describe(r.url()) }); };
  const onFailed = (r) => {
    const why = r.failure()?.errorText || 'failed';
    if (/ERR_ABORTED/i.test(why)) return;
    failedRequests.push({ status: why, ...describe(r.url()) });
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);
  page.on('requestfailed', onFailed);

  return {
    stop() {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      page.off('response', onResponse);
      page.off('requestfailed', onFailed);
      const uniq = (a) => [...new Set(a)].slice(0, 25);
      return { consoleErrors: uniq(consoleErrors), pageErrors: uniq(pageErrors), failedRequests: failedRequests.slice(0, 25) };
    },
  };
}

/**
 * Walk one journey on one environment, one step at a time.
 * `onStep(index, capture)` is called after each step so the caller can pair the
 * two environments up and diff them.
 *
 * @returns {Promise<object[]>} one capture per step
 */
export async function walk(page, journey, baseUrl, opts) {
  const { shotDir, prefix, steps, fullPage = true } = opts;
  const ownHost = new URL(baseUrl).hostname;
  const out = [];

  const url = baseUrl + journey.path;
  let navError = '';
  const started = Date.now();
  const w0 = watch(page, ownHost);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    navError = norm(e.message).slice(0, 300);
  }
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  for (const [i, step] of steps.entries()) {
    const watcher = i === 0 ? w0 : watch(page, ownHost);
    const t0 = Date.now();
    let stepsRun = [];
    if (step.do?.length) stepsRun = await runSteps(page, step.do);
    if (step.wait) await page.waitForTimeout(step.wait);
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

    const id = `${journey.id}-s${i + 1}`;
    const { shots, error, ...dom } = await snapshot(page, { shotDir, prefix, id, fullPage });
    const events = watcher.stop();

    out.push({
      routeId: id,
      url,
      finalUrl: page.url(),
      redirected: false,
      status: i === 0 ? 200 : 200,
      navError: i === 0 ? navError || error : error,
      timings: { domReadyMs: Date.now() - t0, idleMs: i === 0 ? Date.now() - started : Date.now() - t0 },
      stepsRun,
      consoleWarnings: [],
      ownHost,
      shots,
      ...events,
      ...dom,
    });
  }
  return out;
}

/**
 * The steps of a journey that this run is allowed to perform. Steps that create
 * real data are dropped (and reported) unless --allow-writes was passed.
 */
export function stepsFor(journey, allowWrites) {
  const kept = [];
  const skipped = [];
  for (const s of journey.steps) {
    if (s.writes && !allowWrites) skipped.push(s);
    else kept.push(s);
  }
  return { steps: kept, skipped };
}

/**
 * Fill in {{placeholders}} in a journey's steps — mainly the unique email a
 * signup needs, so a write-enabled run does not collide with the last one.
 */
export function withVars(journey, vars) {
  const swap = (v) =>
    typeof v === 'string' ? v.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m)) : v;
  const mapAction = (a) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, swap(v)]));
  return {
    ...journey,
    steps: journey.steps.map((s) => ({ ...s, do: (s.do || []).map(mapAction) })),
  };
}
