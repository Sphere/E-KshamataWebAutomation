/**
 * Records WHICH self-assessment and WHICH course each competency level used —
 * by do_id and by name — so a run can be traced back to exact content.
 *
 * Everything recorded here lands in all three report files, because each entry
 * is emitted as a `test.step` (→ the HTML/PDF step list and the Excel "Steps"
 * sheet) and attached as JSON (→ the run report's attachment section). A
 * standalone JSON + CSV is also written for offline/manual cross-checking:
 *
 *   test-reports/competency-artifacts/<competency>_<timestamp>.json
 *   test-reports/competency-artifacts/<competency>_<timestamp>.csv
 */
import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

export type ArtifactKind = 'self-assessment' | 'course';

export interface CompetencyArtifact {
  /** Competency level this belongs to (1-based). */
  level: number;
  kind: ArtifactKind;
  /** The Sunbird content id, e.g. do_11342049404909158411532. */
  doId: string;
  /** On-screen title of the assessment / course ('' when the UI shows none). */
  name: string;
  /** passed | failed | failed-deliberately | completed | opened */
  outcome: string;
  url: string;
}

const entries: CompetencyArtifact[] = [];

/** Pull the do_id out of any viewer/course URL. */
export function doIdFromUrl(url: string): string {
  return (url.match(/(?:viewer\/\w+\/|content\/|toc\/)(do_\w+)/) || [])[1] || '';
}

/** The COURSE id — the player carries it as ?collectionId=do_… */
export function collectionIdFromUrl(url: string): string {
  return (url.match(/[?&]collectionId=(do_\w+)/) || [])[1] || '';
}

/**
 * Record one artifact and mirror it into the step trail, so the do_id + name
 * show up in the HTML, PDF and Excel reports without any extra plumbing.
 */
export async function recordArtifact(a: CompetencyArtifact): Promise<void> {
  entries.push(a);
  const label =
    `📌 Level ${a.level} · ${a.kind}: "${a.name || '(untitled)'}" ` +
    `[${a.doId || 'no do_id'}] — ${a.outcome}`;
  console.log(`[ARTIFACT] ${label}  ${a.url}`);
  await test.step(label, async () => {});
}

export function artifacts(): CompetencyArtifact[] {
  return [...entries];
}

/** Write the JSON + CSV files and attach the JSON to the test. */
export async function saveArtifacts(competency: string): Promise<string | null> {
  if (!entries.length) return null;

  const dir = path.resolve(process.cwd(), 'test-reports', 'competency-artifacts');
  fs.mkdirSync(dir, { recursive: true });
  const safe = competency.replace(/[^\wऀ-ॿ]+/g, '_').slice(0, 60) || 'competency';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = path.join(dir, `${safe}_${stamp}`);

  const payload = { competency, generatedAt: new Date().toISOString(), entries };
  fs.writeFileSync(`${base}.json`, JSON.stringify(payload, null, 2), 'utf-8');

  const esc = (v: string | number) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [
    ['level', 'kind', 'do_id', 'name', 'outcome', 'url'].join(','),
    ...entries.map((e) => [e.level, e.kind, e.doId, e.name, e.outcome, e.url].map(esc).join(',')),
  ].join('\n');
  fs.writeFileSync(`${base}.csv`, csv, 'utf-8');

  // Attach so the run report carries the table inline too.
  await test.info().attach('competency-artifacts', {
    body: JSON.stringify(payload, null, 2),
    contentType: 'application/json',
  }).catch(() => {});

  console.log(`\n📎 Competency artifacts (do_id + name) saved:\n   ${base}.json\n   ${base}.csv`);
  for (const e of entries) {
    console.log(`   L${e.level} ${e.kind.padEnd(15)} ${(e.doId || '-').padEnd(28)} ${e.outcome.padEnd(20)} ${e.name}`);
  }
  return `${base}.json`;
}

/** Clear between runs (the module is re-imported per worker, but be explicit). */
export function resetArtifacts(): void {
  entries.length = 0;
}
