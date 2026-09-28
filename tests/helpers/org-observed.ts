/**
 * Records what each org's homepage ACTUALLY showed, and decides pass/fail from
 * that rather than from a frozen number.
 *
 * The mapped-course counts grow as content is published — when competencies are
 * added to a homepage, the "For You" count rises with them. A pinned `forYou: 73`
 * therefore fails the moment the platform gains content, which says nothing about
 * a regression. So the fixture numbers are treated as MINIMUMS:
 *
 *   actual <  expected → FAIL (content disappeared — a real regression)
 *   actual >  expected → PASS, logged loudly as drift so the fixture can be updated
 *   actual == expected → PASS
 *
 * Every observation is written to test-reports/org-content-observed.{json,csv}
 * so the current live numbers are always visible.
 */
import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

export interface Observation {
  org: string;
  designation: string;
  email: string;
  type: string;
  /** What the homepage showed: competency cards / program cards / For You etc. */
  observed: Record<string, number | string | null>;
  expected: Record<string, number | null>;
  drift: string;
  titles?: string[];
}

const DIR = path.resolve(process.cwd(), 'test-reports');
const LOG = path.join(DIR, 'org-content-observed.jsonl');

/**
 * Appended immediately, one JSON line per observation.
 *
 * Playwright restarts the worker process after a failing test, which wipes any
 * module-level array — the first version of this kept only the last worker's
 * rows (7 of 12). Appending to a file survives those restarts.
 */
export function recordObservation(o: Observation): void {
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify(o) + '\n', 'utf-8');
}

/** Truncate the log at the start of a run (called by the run-report reporter). */
export function resetObservations(): void {
  try { fs.rmSync(LOG, { force: true }); } catch { /* ignore */ }
}

function readAll(): Observation[] {
  if (!fs.existsSync(LOG)) return [];
  const byKey = new Map<string, Observation>();
  for (const line of fs.readFileSync(LOG, 'utf-8').split('\n').filter(Boolean)) {
    try {
      const o = JSON.parse(line) as Observation;
      byKey.set(`${o.org}/${o.designation}`, o); // last write wins
    } catch { /* skip a partial line */ }
  }
  return [...byKey.values()];
}

/**
 * Compare a live count against the fixture minimum.
 * @returns '' when fine, or a human-readable drift note.
 */
export function checkMinimum(
  actual: number | null,
  expected: number | null | undefined,
  label: string,
): { ok: boolean; drift: string; message: string } {
  if (actual == null) return { ok: false, drift: '', message: `${label}: nothing rendered` };
  if (expected == null) return { ok: true, drift: '', message: `${label}: ${actual} (no expectation — observational)` };
  if (actual < expected) {
    return {
      ok: false,
      drift: `SHRANK ${expected}→${actual}`,
      message: `${label}: ${actual}, expected at least ${expected} — content is MISSING`,
    };
  }
  if (actual > expected) {
    return {
      ok: true,
      drift: `grew ${expected}→${actual}`,
      message: `${label}: ${actual} (fixture says ${expected} — content was ADDED; update the fixture)`,
    };
  }
  return { ok: true, drift: '', message: `${label}: ${actual} (matches)` };
}

/** Write the observed snapshot next to the other reports. */
export function saveObservations(): string | null {
  const observations = readAll();
  if (!observations.length) return null;
  fs.mkdirSync(DIR, { recursive: true });
  const base = path.join(DIR, 'org-content-observed');

  fs.writeFileSync(`${base}.json`,
    JSON.stringify({ generatedAt: new Date().toISOString(), observations }, null, 2), 'utf-8');

  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = observations.map((o) => [
    o.org, o.designation, o.email, o.type,
    JSON.stringify(o.observed), JSON.stringify(o.expected), o.drift, (o.titles || []).join(' | '),
  ].map(esc).join(','));
  fs.writeFileSync(`${base}.csv`,
    ['org,designation,email,type,observed,expected,drift,titles', ...rows].join('\n'), 'utf-8');

  console.log(`\n📋 What each org's homepage actually shows → ${base}.json / .csv`);
  for (const o of observations) {
    console.log(`   ${o.org}/${o.designation}  ${o.type.padEnd(11)} ${JSON.stringify(o.observed)}${o.drift ? `  [${o.drift}]` : ''}`);
  }
  return `${base}.json`;
}

/** Retry a step through transient network faults (ERR_INTERNET_DISCONNECTED …). */
export async function withNetworkRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      last = e;
      const msg = String(e?.message ?? e);
      // A navigation that times out is as transient as a dropped connection —
      // NHMMP died on "page.goto: Timeout 60000ms exceeded" and was reported as
      // a content failure. Retry those too, but never a TEST timeout (that is
      // the budget running out, not the network).
      const transient =
        /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_CONNECTION_(RESET|CLOSED|TIMED_OUT)|ERR_NAME_NOT_RESOLVED|ERR_TIMED_OUT|net::/i.test(msg)
        || (/page.(goto|waitForURL|reload): Timeout/i.test(msg) && !/Test timeout/i.test(msg));
      if (!transient || i === attempts) throw e;
      console.log(`[VALIDATE] ⚠️  ${label}: transient network error (attempt ${i}/${attempts}) — ${msg.split('\n')[0].slice(0, 90)}`);
      await test.info().attach(`network-retry-${i}`, { body: msg.slice(0, 2000), contentType: 'text/plain' }).catch(() => {});
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  throw last;
}
