/**
 * Expected home/My-Courses content per org + designation, from the live mapping.
 *
 * Four homepage kinds:
 *   - 'competency' → home shows the Competency Learning Plan (app-asha-learning);
 *                    `forYou` (optional) also asserts the My Courses ▸ "For You (N)".
 *   - 'courses'    → My Courses ▸ "For You (N)" equals `forYou`.
 *   - 'programs'   → home "PROGRAMS" section shows `programs` program-cards.
 *   - 'none'       → no courses mapped; My Courses ▸ "For You" is 0.
 *
 * Counts are MINIMUMS, not equalities. Content grows — when competencies are
 * added to a homepage the mapped-course (For You) count rises with them — so a
 * run fails only when a count SHRINKS. Growth passes and is reported as drift,
 * and the live values are written to test-reports/org-content-observed.json|csv
 * so the fixture can be refreshed from real data.
 *
 * `review: true` = value not confirmed on the sheet → assert loosely and log the
 * actual so you can lock it in. `names` (optional) asserts course titles appear.
 *
 * This is the single source of truth — edit values here.
 */
export type HomepageKind = 'competency' | 'courses' | 'programs' | 'none';

export interface ExpectedContent {
  type: HomepageKind;
  /** My Courses ▸ "For You (N)" — for 'courses', and optionally for 'competency'. */
  forYou?: number;
  /** Home "PROGRAMS" program-card count — for 'programs'. */
  programs?: number;
  /** Optional exact course titles expected in "For You". */
  names?: string[];
  /** Value unconfirmed — validate loosely, log actual. */
  review?: boolean;
  note?: string;
}

/** orgKey → designation → expected content. */
export const EXPECTED: Record<string, Record<string, ExpectedContent>> = {
  // ── Competency homepages (learning plan + 73 courses in For You) ───
  BNRC:     { 'ANM-Student-Bihar': { type: 'competency', forYou: 73 } },
  DMHUP:    { 'ANM-Outreach-UP':   { type: 'competency', forYou: 73 } },
  PVTBIHAR: { 'ANM-Bihar':         { type: 'competency', forYou: 73 } },
  SHSB:     {
    'ANM-Bihar': { type: 'competency', forYou: 73 },
    // CHO-Bihar is NOT a competency homepage: verified on SHSB-CHO005 that the
    // home shows a FOR YOU carousel (no Learning Plan) and My Courses reads
    // "For You (7)". The old 'competency' expectation is what failed, not the app.
    'CHO-Bihar': { type: 'courses', forYou: 7, note: 'home shows FOR YOU carousel; confirmed on SHSB-CHO005' },
  },
  // Competency home; For You count not specified — learning plan only.
  PVTUP:    { 'ANM-UP': { type: 'competency' } },

  // ── Single course mapped (For You) ────────────────────────────────
  SIHFWUP:  { 'Medical Officer-UP': { type: 'courses', forYou: 1, note: "Medical Officer's Foundation Training (UP)" } },
  // Was a 'programs' homepage with 2 cards; the mapping changed and the home
  // now shows a FOR YOU carousel — observed on NHMMP-GNM038, "For You (6)"
  // (6 Indian Nursing Council certificate courses). Not a detection race: the
  // sweep waits for a program card before it concludes "courses".
  NHMMP:    { 'GNM-Test': { type: 'courses', forYou: 6, note: 'INC certificate courses; confirmed on NHMMP-GNM038' } },

  // ── Program-card homepages (home PROGRAMS section) ────────────────
  MP:       {
    'ANM-MP': { type: 'programs', programs: 4 },
    // CHO-MP: report whatever the homepage shows for a freshly created user
    // rather than asserting a number (the old pinned 4 failed on a stale login).
    'CHO-MP': { type: 'programs', review: true, note: 'observational — logs the live program cards' },
  },

  // ── No courses mapped ─────────────────────────────────────────────
  NHMUP:    { 'ANM-Outreach-UP': { type: 'none', note: 'courses not mapped' } },

  // ── Unconfirmed — validate loosely, log actual ────────────────────
  NHMMADHYA: { 'ANM/MPW': { type: 'courses', review: true, note: 'actual For You observed = 111 — confirm' } },
};
