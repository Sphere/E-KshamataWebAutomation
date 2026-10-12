import { BASE_URL, authHeaders } from '../api/Ekshamata-api';

/**
 * Deterministic self-assessment answers.
 *
 * Every quiz (questionset) has a PUBLIC artifact JSON (S3) listing all bank
 * questions with `isCorrect` per option. We fetch it once per quiz and build a
 * lookup so the test can pick the correct option for whatever questions the
 * player renders.
 *
 *   quiz do_id  --questionset read-->  artifactUrl  --GET-->  quiz.json (answers)
 */

/** Normalise text for robust matching (strip tags/entities, collapse ws, lowercase). */
export function normalize(s: string): string {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/[ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function getArtifactUrl(quizId: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/questionset/v1/hierarchy/${quizId}?mode=edit`, {
    headers: authHeaders(),
  });
  const json: any = await res.json();
  const url: string | undefined = json?.result?.questionSet?.artifactUrl;
  if (!url) throw new Error(`No artifactUrl for quiz ${quizId}:\n${JSON.stringify(json).slice(0, 300)}`);
  return url;
}

/** The correct answer(s) for one question, keyed by its question-id (e.g. "Q109"). */
export interface QuestionKey {
  /** correct optionIds for this question, e.g. "Q109-d". */
  correctIds: Set<string>;
  /** normalized correct option texts for this question (robust to option re-lettering). */
  correctTexts: Set<string>;
}

export interface AnswerKey {
  /** all correct optionIds, e.g. "Q156-c" — matched against the radio input's `value`. */
  correctOptionIds: Set<string>;
  /** normalized question text -> normalized correct option text (fallback). */
  byQuestion: Map<string, string>;
  /** all normalized correct option texts (fallback). */
  correctOptions: Set<string>;
  /**
   * question-id (e.g. "Q109") -> its correct ids + texts. This is the primary
   * lookup: the player renders each option's id as the radio `value` ("Q109-a"),
   * but on mixed quizzes it *subsets and re-letters* options, so the correct
   * optionId may not appear verbatim — we then fall back to matching option TEXT.
   */
  byQid: Map<string, QuestionKey>;
  /**
   * The full question bank, normalized, with each option's correctness. Used by
   * the per-page answering engine (ported from Sphere CompleteCompetency): it
   * scrapes the on-screen question, matches it here by text, and picks the
   * correct option — robust to the web player paginating one question per page.
   */
  pool: PoolQuestion[];
  size: number;
}

export interface PoolQuestion {
  question: string;                                   // normalized question text
  options: { text: string; isCorrect: boolean }[];    // normalized option texts
}

/** The question-id portion of an optionId ("Q109-d" -> "Q109"). */
export function qidOf(optionId: string): string {
  const m = String(optionId).match(/^(Q\d+)/i);
  return m ? m[1] : String(optionId).split('-')[0];
}

/** Build an AnswerKey from a raw quiz.json (questions[].options[].isCorrect). */
export function buildAnswerKey(quiz: any): AnswerKey {
  const correctOptionIds = new Set<string>();
  const byQuestion = new Map<string, string>();
  const correctOptions = new Set<string>();
  const byQid = new Map<string, QuestionKey>();
  const pool: PoolQuestion[] = [];
  for (const q of quiz?.questions || []) {
    // Full pool (every option, correct or not) for the scrape-and-match engine.
    pool.push({
      question: normalize(q.question),
      options: (q.options || []).map((o: any) => ({ text: normalize(o.text), isCorrect: !!o.isCorrect })),
    });

    const corrects = (q.options || []).filter((o: any) => o.isCorrect);
    if (!corrects.length) continue;
    for (const c of corrects) {
      if (c.optionId) {
        correctOptionIds.add(c.optionId); // all correct (handles multi-select)
        const qid = qidOf(c.optionId);
        if (!byQid.has(qid)) byQid.set(qid, { correctIds: new Set(), correctTexts: new Set() });
        const entry = byQid.get(qid)!;
        entry.correctIds.add(c.optionId);
        entry.correctTexts.add(normalize(c.text));
      }
      correctOptions.add(normalize(c.text));
    }
    byQuestion.set(normalize(q.question), normalize(corrects[0].text));
  }
  return { correctOptionIds, byQuestion, correctOptions, byQid, pool, size: byQuestion.size };
}

/**
 * Union two AnswerKeys so coverage grows across questionsets.
 *
 * An in-course POST-assessment draws its questions from SEVERAL questionsets,
 * but the key was fetched once for a single do_id — so only that set's questions
 * matched and the rest were left blank (a 10-question quiz answered 1, failed,
 * and left the course short of 100%). Merging each page's questionset in as the
 * quiz advances gives the per-page matcher the full bank.
 *
 * The `pool` (the primary matcher's source, keyed by question TEXT) is merged in
 * full. `byQid` only ADDS new qids and never unions a colliding one: question
 * ids repeat across questionsets (every set starts at Q100…), so unioning them
 * would mix two different questions' answers. The pool match already covers the
 * colliding ones, and the byQid fallback stays un-poisoned.
 */
export function mergeAnswerKeys(a: AnswerKey | null, b: AnswerKey | null): AnswerKey | null {
  if (!a) return b;
  if (!b) return a;

  const correctOptionIds = new Set<string>([...a.correctOptionIds, ...b.correctOptionIds]);
  const correctOptions = new Set<string>([...a.correctOptions, ...b.correctOptions]);

  const byQuestion = new Map<string, string>(a.byQuestion);
  for (const [q, t] of b.byQuestion) if (!byQuestion.has(q)) byQuestion.set(q, t);

  // ADD-ONLY on qid: never union a colliding qid (would mix questionsets).
  const byQid = new Map<string, QuestionKey>();
  for (const [qid, k] of a.byQid) byQid.set(qid, { correctIds: new Set(k.correctIds), correctTexts: new Set(k.correctTexts) });
  for (const [qid, k] of b.byQid) if (!byQid.has(qid)) byQid.set(qid, { correctIds: new Set(k.correctIds), correctTexts: new Set(k.correctTexts) });

  // Pool is keyed by question text — merge in full, deduped.
  const seen = new Set<string>(a.pool.map((p) => p.question));
  const pool = [...a.pool];
  for (const p of b.pool) if (p.question && !seen.has(p.question)) { seen.add(p.question); pool.push(p); }

  return { correctOptionIds, byQuestion, correctOptions, byQid, pool, size: byQuestion.size };
}

/**
 * Fetch + build the answer key for a quiz content id (token path — questionset
 * hierarchy in edit mode; needs SPHERE_API_TOKEN). Prefer the session-based
 * fetchRealAnswerKey() (tests/helpers/real-answer-key.ts) which needs no token.
 */
export async function fetchAnswerKey(quizId: string): Promise<AnswerKey> {
  const artifactUrl = await getArtifactUrl(quizId);
  const quiz: any = await (await fetch(artifactUrl)).json();
  return buildAnswerKey(quiz);
}

/** The quiz content id embedded in a player URL like /viewer/quiz/do_xxx?... */
export function quizIdFromUrl(url: string): string | null {
  const m = url.match(/\/viewer\/quiz\/(do_\d+)/);
  return m ? m[1] : null;
}
