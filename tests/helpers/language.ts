import type { Page } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'https://ekshamata.aastrika.org';

/** True if the portal is currently rendering in Hindi (lots of Devanagari on home). */
export async function isHindi(page: Page): Promise<boolean> {
  await page.goto(`${BASE}/page/home`).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2_500);
  // Count Devanagari across the whole page — the Hindi UI has plenty; a stray
  // Hindi competency title in an English UI would be only a handful.
  return page.evaluate(() => ((document.body.innerText || '').match(/[ऀ-ॿ]/g) || []).length > 25).catch(() => false);
}

// The language screen is itself translated, so the option you are switching TO
// is written in the language the portal is CURRENTLY in:
//   English UI → "English" / "हिंदी",  save button "Save"
//   Hindi UI   → "अंग्रेजी" / "हिंदी",  save button "सेव करें"
// Matching only the English spellings is why switching back out of Hindi
// silently did nothing.
const OPTION_LABEL = {
  English: /^\s*(english|अंग्रेजी|अंग्रेज़ी)\s*$/i,
  'हिंदी': /^\s*(हिंदी|हिन्दी|hindi)\s*$/i,
} as const;

const SAVE_LABEL = /save|apply|confirm|proceed|update|yes|ok|done|submit|सेव|सहेज|बदल/i;

/** Open Account → Language Preference and pick a language ("हिंदी" or "English"). */
async function setLanguage(page: Page, label: 'हिंदी' | 'English'): Promise<void> {
  // Start from home so the Account nav is always present and clickable.
  await page.goto(`${BASE}/page/home`).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1_500);
  await page.getByRole('button', { name: /^(account|खाता)$/i }).or(page.getByText(/^(account|खाता)$/i)).first().click().catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2_500);
  await page.getByText(/language preference|भाषा/i).first().click().catch(() => {});
  await page.waitForTimeout(1_500);
  // Pick the option in whichever language the screen is currently rendered in.
  await page.getByText(OPTION_LABEL[label]).first().click().catch(() => {});
  await page.waitForTimeout(1_000);
  // Saving is REQUIRED — the choice is not applied until this is clicked.
  await page.getByRole('button', { name: SAVE_LABEL })
    .first().click({ timeout: 2_500 }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2_500);
}

/**
 * Ensure the portal language is HINDI — some competencies only present their
 * self-assessment quiz in Hindi (English serves a video instead). Sets हिंदी via
 * Account → Language Preference and verifies it applied; if it doesn't take, does
 * ONE English↔Hindi toggle. Returns true once Hindi is on.
 */
export async function ensureHindi(page: Page): Promise<boolean> {
  if (await isHindi(page)) { console.log('[lang] already Hindi'); return true; }

  await setLanguage(page, 'हिंदी');
  if (await isHindi(page)) { console.log('[lang] ✅ Hindi set'); return true; }

  console.log('[lang] Hindi did not take — toggling English↔Hindi once');
  await setLanguage(page, 'English');
  await setLanguage(page, 'हिंदी');
  const ok = await isHindi(page);
  console.log(ok ? '[lang] ✅ Hindi set after toggle' : '[lang] ⚠️ could not confirm Hindi');
  return ok;
}

/**
 * Ensure the portal language is ENGLISH.
 *
 * This has to switch the language ACTIVELY, not just skip the Hindi step: the
 * portal language is a persisted ACCOUNT setting, so once a run has answered
 * "yes, set Hindi", every later run stays in Hindi until something sets it back.
 * Declining the Hindi prompt therefore has to mean "make sure it's English".
 */
export async function ensureEnglish(page: Page): Promise<boolean> {
  if (!(await isHindi(page))) { console.log('[lang] already English'); return true; }

  console.log('[lang] portal is in Hindi — switching to English');
  await setLanguage(page, 'English');
  if (!(await isHindi(page))) { console.log('[lang] ✅ English set'); return true; }

  console.log('[lang] English did not take — toggling Hindi↔English once');
  await setLanguage(page, 'हिंदी');
  await setLanguage(page, 'English');
  const ok = !(await isHindi(page));
  console.log(ok ? '[lang] ✅ English set after toggle' : '[lang] ⚠️ could not confirm English');
  return ok;
}

/** Ensure the portal is in the requested language. */
export async function ensureLanguage(page: Page, lang: 'hi' | 'en'): Promise<boolean> {
  return lang === 'hi' ? ensureHindi(page) : ensureEnglish(page);
}
