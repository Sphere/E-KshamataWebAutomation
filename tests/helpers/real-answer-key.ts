import type { Page } from '@playwright/test';
import { buildAnswerKey, type AnswerKey } from '../../src/utils/answer-key';

/**
 * Session-based, token-FREE answer-key capture.
 *
 * As the browser loads the quiz it fetches the questionset (which carries the S3
 * `artifactUrl`) and/or the S3 quiz.json itself. We watch the network and:
 *   • grab any quiz.json whose options already carry `isCorrect` (the real key), or
 *   • grab the `artifactUrl` and fetch that public S3 file with the page session.
 * No SPHERE_API_TOKEN needed.
 */
// A self-assessment is often a MIXED quiz that pulls questions from SEVERAL
// questionsets, so we collect EVERY quiz.json + artifactUrl seen on the wire and
// merge them — capturing only the last one leaves rendered questions unanswered.
const pendingRealKeys: any[] = [];             // quiz.jsons (with isCorrect) seen since last fetch
const pendingArtifactUrls = new Set<string>(); // questionset artifactUrls seen since last fetch
// ACCUMULATE across the whole run: a big paginated assessment (e.g. 87 questions)
// loads its questionsets progressively, so a single fetch at the intro misses
// most of them. We keep every questionset ever fetched and build the key from
// ALL of them, so re-fetching after more have loaded yields fuller coverage.
const accumulatedQuizzes: any[] = [];
const fetchedArtifacts = new Set<string>();

function looksReal(quiz: any): boolean {
  const qs = quiz?.questions;
  if (!Array.isArray(qs) || !qs.length) return false;
  // "real" = at least one question has a correct option marked
  return qs.some((q: any) => (q.options || []).some((o: any) => o?.isCorrect === true));
}

/** Attach the network capture BEFORE the quiz loads. */
export function captureApiHeaders(page: Page): void {
  page.on('response', async (res) => {
    const url = res.url();
    try {
      // 1) a quiz.json artifact on the wire (S3 or proxied) — collect all
      if (/_quiz\.json|\/artifact\/.*\.json/i.test(url) && res.ok()) {
        const j = await res.json().catch(() => null);
        if (j && Array.isArray(j.questions) && looksReal(j)) pendingRealKeys.push(j);
        return;
      }
      // 2) a questionset / content read or hierarchy → pull the artifactUrl(s)
      if (/(questionset|content)\/v\d\/(read|hierarchy)|\/apis\/proxies\/.*(questionset|hierarchy)/i.test(url) && res.ok()) {
        const j = await res.json().catch(() => null);
        collectArtifactUrls(j?.result, pendingArtifactUrls);
      }
    } catch { /* ignore */ }
  });
}

/** Recursively pull every `artifactUrl` out of a questionset/hierarchy result. */
function collectArtifactUrls(node: any, out: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((n) => collectArtifactUrls(n, out)); return; }
  if (typeof node.artifactUrl === 'string' && /\.json/i.test(node.artifactUrl)) out.add(node.artifactUrl);
  for (const k of Object.keys(node)) {
    const v = (node as any)[k];
    if (v && typeof v === 'object') collectArtifactUrls(v, out);
  }
}

/**
 * Build the real key from whatever the network capture found (token-free),
 * MERGING every quiz.json + fetched artifact into one pool so a mixed quiz that
 * spans several questionsets is fully covered.
 */
export async function fetchRealAnswerKey(page: Page): Promise<AnswerKey | null> {
  // The browser fetches the quiz artifact/questionset a beat after the viewer
  // opens — wait for the capture before giving up.
  for (let i = 0; i < 15 && !pendingRealKeys.length && !pendingArtifactUrls.size; i++) {
    await page.waitForTimeout(1_000);
  }

  // Absorb newly-seen quiz.jsons + fetch newly-seen artifacts into the accumulator.
  while (pendingRealKeys.length) accumulatedQuizzes.push(pendingRealKeys.shift());
  for (const art of [...pendingArtifactUrls]) {
    pendingArtifactUrls.delete(art);
    if (fetchedArtifacts.has(art)) continue;
    fetchedArtifacts.add(art);
    try {
      const r = await page.request.get(art); // public S3 artifact (browser session)
      if (r.ok()) {
        const quiz = await r.json();
        if (looksReal(quiz)) accumulatedQuizzes.push(quiz);
      }
    } catch { /* ignore */ }
  }
  if (!accumulatedQuizzes.length) return null;
  return mergedKey();
}

/** Merge every accumulated questionset into ONE key (de-duped). */
function mergedKey(): AnswerKey | null {
  if (!accumulatedQuizzes.length) return null;
  // Merge ALL accumulated questions (de-duped by identifier) into one key.
  const seen = new Set<string>();
  const merged: any = { questions: [] };
  for (const q of accumulatedQuizzes) {
    for (const question of (q.questions || [])) {
      // De-dupe on something ACTUALLY unique. A 40-char JSON prefix is not:
      // every level numbers its questions from Q100, so the prefix
      // {"questionId":"Q100","question":"<p>What  is identical across levels and
      // silently dropped 16 of this competency's 38 questions — the picker then
      // found no options for them and left them unanswered.
      const stem = String(question?.question || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const id = String(question?.identifier || question?.id || `${question?.questionId || ''}|${stem}`);
      if (seen.has(id)) continue;
      seen.add(id);
      merged.questions.push(question);
    }
  }
  return merged.questions.length ? buildAnswerKey(merged) : null;
}

/**
 * Fetch a level's answer key DIRECTLY by its content id — no network sniffing.
 *
 *   /api/content/v1/read/<do_id>  →  result.content.artifactUrl  →  quiz.json
 *
 * Sniffing the wire is racy: a level's questionset is often not on the wire yet
 * when we start answering, which left the pool without that level's questions.
 * The picker then fell back to matching by question id — and ids repeat across
 * levels (every level numbers its questions Q100, Q101…), so an L3 question got
 * answered with L2's "Q10x" correct option. Reading the artifact by id removes
 * the race entirely.
 *
 * The fetched quiz is also pushed into the accumulator, so the merged key keeps
 * covering every level seen so far.
 */
export async function fetchKeyByDoId(page: Page, doId: string): Promise<AnswerKey | null> {
  if (!doId) return null;
  const base = (process.env.BASE_URL || 'https://ekshamata.aastrika.org').replace(/\/+$/, '');
  try {
    const meta = await page.request.get(`${base}/api/content/v1/read/${doId}?fields=artifactUrl,name`);
    if (!meta.ok()) return null;
    const artifactUrl: string = (await meta.json())?.result?.content?.artifactUrl || '';
    if (!artifactUrl) return null;
    if (!fetchedArtifacts.has(artifactUrl)) {
      const res = await page.request.get(artifactUrl);
      if (!res.ok()) return null;
      const quiz = await res.json();
      if (!looksReal(quiz)) return null;
      fetchedArtifacts.add(artifactUrl);
      accumulatedQuizzes.push(quiz);
      console.log(`[key] fetched answer key by id ${doId}: ${(quiz.questions || []).length} questions`);
    }
  } catch {
    return null;
  }
  return mergedKey();
}
