/**
 * The LIVE course catalogue of whichever environment we are pointed at, and
 * name → do_id resolution against it.
 *
 * Production and staging hold different course sets, so a course is always
 * resolved against the environment under test rather than from a fixture.
 * Shared by course-complete.spec.ts and certificate.spec.ts so both accept the
 * same COURSE_NAME / COURSE_ID inputs and fail the same way.
 */
export type Course = { name: string; identifier: string };

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Every Live, learner-facing course on this environment.
 *
 * `competency: true` marks a COMPETENCY container rather than a course — it
 * shares primaryCategory "Course", is named after the competency and is not
 * openable as a course, so those are dropped.
 */
export async function liveCourses(origin: string): Promise<Course[]> {
  const found = new Map<string, string>();
  const PAGE = 200;
  for (let offset = 0; offset < 4000; offset += PAGE) {
    const res = await fetch(`${origin}/api/content/v1/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request: {
          filters: { primaryCategory: ['Course'], status: ['Live'] },
          fields: ['name', 'identifier', 'competency'],
          sort_by: { name: 'asc' },
          limit: PAGE,
          offset,
        },
      }),
    });
    if (!res.ok) throw new Error(`course search returned HTTP ${res.status} on ${origin}`);
    const body: any = await res.json();
    const batch: any[] = body?.result?.content ?? [];
    for (const c of batch) {
      if (c.competency === true) continue;
      const name = String(c.name ?? '').replace(/\s+/g, ' ').trim();
      if (name && !found.has(name)) found.set(name, c.identifier);
    }
    const total = body?.result?.count ?? 0;
    if (!batch.length || offset + PAGE >= total) break;
  }
  return [...found.entries()].map(([name, identifier]) => ({ name, identifier }));
}

/** Resolve a course name on this environment: exact title first, then substring. */
export async function resolveCourse(
  origin: string,
  want: { name: string; id?: string },
): Promise<Course> {
  if (want.id) return { name: want.name || want.id, identifier: want.id };

  const all = await liveCourses(origin);
  const exact = all.filter((c) => norm(c.name) === norm(want.name));
  if (exact.length) return exact[0];

  const partial = all.filter((c) => norm(c.name).includes(norm(want.name)));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(
      `"${want.name}" matches ${partial.length} courses on ${new URL(origin).hostname} — ` +
        `name one exactly, or pass COURSE_ID:\n  ` +
        partial.slice(0, 15).map((c) => `${c.name}  [${c.identifier}]`).join('\n  '),
    );
  }
  throw new Error(
    `No live course matches "${want.name}" on ${new URL(origin).hostname} ` +
      `(${all.length} courses there). List them with: npm run courses:list`,
  );
}
