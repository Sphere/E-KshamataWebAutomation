/**
 * The live course catalogue, shared by scripts/run.mjs and scripts/run-course.mjs.
 *
 * Courses are fetched from the chosen environment (POST /api/content/v1/search,
 * Live courses) and cached per host for a day, so switching environments never
 * shows the wrong catalogue.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const cacheFile = (apiOrigin) =>
  resolve(ROOT, '.cache', `courses-${new URL(apiOrigin).hostname}.json`);

/** Every Live, learner-facing course on `apiOrigin`, sorted by name. */
export async function fetchCourses(apiOrigin, print = console.log) {
  const names = new Map(); // name → { identifier, certificate }
  let skipped = 0;
  const PAGE = 200;
  for (let offset = 0; offset < 4000; offset += PAGE) {
    const res = await fetch(`${apiOrigin}/api/content/v1/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request: {
          filters: { primaryCategory: ['Course'], status: ['Live'] },
          fields: ['name', 'identifier', 'competency', 'issueCertification'],
          sort_by: { name: 'asc' },
          limit: PAGE,
          offset,
        },
      }),
    });
    if (!res.ok) throw new Error(`search API returned HTTP ${res.status}`);
    const body = await res.json();
    const batch = body?.result?.content ?? [];
    for (const c of batch) {
      // `competency: true` marks a COMPETENCY container, not a learner-facing
      // course. They share primaryCategory "Course" but are named after the
      // competency, are not findable in the portal by that title, and belong to
      // the competency runners instead. Anything else (incl. an unset flag) is
      // a real course.
      if (c.competency === true) { skipped++; continue; }
      const name = String(c.name ?? '').replace(/\s+/g, ' ').trim();
      // `issueCertification` is the portal's own flag for "this course ends in
      // a certificate" — most do not, and that is what makes a certificate run
      // possible or pointless.
      if (name && !names.has(name)) {
        names.set(name, { identifier: c.identifier, certificate: c.issueCertification === true });
      }
    }
    const total = body?.result?.count ?? 0;
    if (!batch.length || offset + PAGE >= total) break;
  }
  if (skipped) print(`\n   (skipped ${skipped} competency entries — those are not courses)`);
  return [...names.entries()]
    .map(([name, info]) => ({ name, identifier: info.identifier, certificate: info.certificate }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The catalogue for `apiOrigin`, from the day-old cache when possible.
 * Returns [] when the platform is unreachable and nothing is cached.
 */
export async function loadCourses(apiOrigin, { refresh = false, print = console.log } = {}) {
  const file = cacheFile(apiOrigin);
  const host = new URL(apiOrigin).hostname;

  if (!refresh && existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, 'utf-8'));
      const hasFlag = cached.courses?.every((c) => 'certificate' in c);
      if (Date.now() - Date.parse(cached.fetchedAt) < CACHE_TTL_MS && cached.courses?.length && hasFlag) {
        print(`📚 ${cached.courses.length} courses on ${host} (cached — use --refresh to re-fetch)`);
        return cached.courses;
      }
    } catch { /* fall through to a live fetch */ }
  }

  print(`📚 Fetching the live course list from ${apiOrigin} … `);
  try {
    const courses = await fetchCourses(apiOrigin, print);
    print(`${courses.length} found`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ fetchedAt: new Date().toISOString(), courses }, null, 2));
    return courses;
  } catch (e) {
    print(`failed (${e.message})`);
    if (existsSync(file)) {
      const cached = JSON.parse(readFileSync(file, 'utf-8'));
      print(`   Falling back to the cached list (${cached.courses.length} courses).`);
      return cached.courses;
    }
    return [];
  }
}
