/**
 * Live competency discovery, shared by the interactive runners.
 *
 * Each org's learning plan differs and the titles change with the language, so
 * the list is always READ FROM THE PORTAL rather than guessed from a hardcoded
 * table. Discovery opens the competency home once (honouring ENSURE_LANG) and
 * returns the real on-screen titles.
 *
 * The list is re-read on EVERY call by default — a stale cache silently offers
 * competencies that no longer exist, or English titles for a Hindi run. The
 * cache is kept only as a fallback for when discovery cannot reach the portal
 * (and can be preferred explicitly with `cached: true`).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(__dirname, '../../.cache');
const require = createRequire(import.meta.url);
const cli = require.resolve('@playwright/test/cli');

const cacheFileFor = (org, lang) =>
  resolve(CACHE_DIR, `competencies.${org}.${lang || 'en'}.json`);

/**
 * @param {object} opts
 * @param {Record<string,string>} opts.env  env for the discovery run (BASE_URL, ORG, ENSURE_LANG…)
 * @param {string} opts.org
 * @param {'hi'|'en'|''} opts.lang
 * @param {boolean} [opts.cached]  prefer the cached list instead of re-reading
 * @returns {{titles: string[], cached: boolean}}
 */
export function discoverCompetencies({ env, org, lang, cached = false }) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = cacheFileFor(org, lang);

  const readCache = () => {
    if (!existsSync(cacheFile)) return null;
    try { return JSON.parse(readFileSync(cacheFile, 'utf8')); } catch { return null; }
  };

  if (cached) {
    const hit = readCache();
    if (hit?.length) return { titles: hit, cached: true };
  }

  const out = resolve(CACHE_DIR, `_discover.${org}.json`);
  try { rmSync(out, { force: true }); } catch { /* ignore */ }
  console.log(`\n🔎 Reading ${org}'s CURRENT learning plan${lang === 'hi' ? ' (हिंदी)' : ' (English)'} from the portal — one moment…\n`);

  const res = spawnSync(
    process.execPath,
    [cli, 'test', 'tests/_discover-competencies.spec.ts', '--project=helpers'],
    { stdio: 'inherit', env: { ...env, COMP_OUT: out, HEADLESS: 'true' } },
  );

  let titles = [];
  if (res.status === 0 && existsSync(out)) {
    try { titles = JSON.parse(readFileSync(out, 'utf8')); } catch { /* empty */ }
  }

  if (titles.length) {
    writeFileSync(cacheFile, JSON.stringify(titles, null, 2));
    return { titles, cached: false };
  }

  // Discovery failed — fall back to the last known list so the run can proceed.
  const stale = readCache();
  if (stale?.length) {
    console.log(`⚠️  Could not read the live plan — falling back to the last known list (${stale.length} competencies).`);
    return { titles: stale, cached: true };
  }
  return { titles: [], cached: false };
}
