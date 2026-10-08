/**
 * Robust OTP retrieval from yopmail — ported from the proven Sphere helper
 * (SphereWebAutomation/tests/helpers/otp.ts), which hits yopmail's own inbox
 * endpoint rather than scraping through a search engine.
 *
 * Why the port: the first version here matched the first 4–8 digit run in the
 * mail body, which picked up the YEAR ("2026") out of the footer instead of the
 * code. The fix is to match by CONTEXT — the Aastrika OTP sentence first, then
 * "OTP … <digits>", then "is <digits>", and only as a last resort any SIX
 * digits (a 4-digit year can never satisfy that).
 *
 *   - fresh navigation to the inbox each attempt (dodges stale iframes),
 *   - attempts + backoff with jitter (mail can take a while to arrive),
 *   - detects yopmail's captcha / rate-limit wall and backs off with a clear log.
 *
 * yopmail rate-limits heavy same-IP usage, so under a big run some misses are
 * still possible — the thrown error says exactly that.
 */
import { BrowserContext, Frame } from '@playwright/test';

const YOPMAIL = 'https://yopmail.com/en/';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (base: number) => base + Math.floor(Math.random() * 1500);

/** The mailbox name without the domain — "foo@yopmail.com" -> "foo". */
export function mailbox(email: string): string {
  return email.trim().toLowerCase().replace(/@yopmail\.com$/i, '').replace(/^@/, '');
}

// Ordered most-specific to least. The first match wins, so precision beats
// recall. The {0,40} gap lets "OTP for Aastrika Sphere Platform is 270423"
// match in one hop; the 6-digit last resort never matches a year like 2026.
const OTP_PATTERNS = [
  /OTP for Aastrika[^0-9]{0,40}(\d{4,8})/i, // the exact Aastrika message
  /OTP[^0-9]{0,40}(\d{4,8})/i,              // "OTP ... <digits>"
  /\bis\s+(\d{4,8})\b/i,                     // "... is <digits>"
  /\b(\d{6})\b/,                             // last resort: any 6 digits
];

/** Pull the code out of a mail body, or null if nothing looks like one. */
function extractOtp(text: string): string | null {
  if (!text) return null;
  for (const re of OTP_PATTERNS) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}

export interface OtpOptions {
  /** How many polling attempts (default 12 ≈ 60–90s with backoff). */
  attempts?: number;
  /** Base delay between attempts in ms (default 5000; jittered). */
  intervalMs?: number;
}

/** Open a fresh yopmail tab, poll the inbox, and return the newest OTP code. */
export async function readYopmailOtp(
  context: BrowserContext,
  email: string,
  opts: OtpOptions = {},
): Promise<string> {
  const attempts = opts.attempts ?? 12;
  const intervalMs = opts.intervalMs ?? 5000;
  const localPart = mailbox(email);
  console.log(`📧 Fetching OTP for: ${email}`);

  const page = await context.newPage();
  try {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        // Navigate straight to the inbox each attempt — a full reload is more
        // reliable than the in-page refresh button and avoids stale frames.
        await page.goto(`${YOPMAIL}?login=${encodeURIComponent(localPart)}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1200);

        // Cookie banner (first load only; harmless otherwise).
        const cookieBtn = page
          .locator('button:has-text("Accept"), button:has-text("OK"), button:has-text("I agree")')
          .first();
        if (await cookieBtn.isVisible({ timeout: 800 }).catch(() => false)) {
          await cookieBtn.click().catch(() => {});
        }

        // Captcha / rate-limit wall → clear log + longer back-off.
        const captcha = await page
          .locator('iframe[src*="recaptcha"], .g-recaptcha')
          .first()
          .isVisible({ timeout: 600 })
          .catch(() => false);
        if (captcha) {
          console.log(`   ⚠️  yopmail captcha wall (attempt ${attempt}/${attempts}) — rate-limited, backing off`);
          await sleep(jitter(intervalMs * 2));
          continue;
        }

        // Open the newest message in the inbox list frame.
        const inboxFrame: Frame | null = page.frame({ name: 'ifinbox' }) ?? null;
        if (inboxFrame) {
          const firstMail = inboxFrame.locator('button.lm, div.m, .mail').first();
          if (await firstMail.isVisible({ timeout: 2000 }).catch(() => false)) {
            await firstMail.click().catch(() => {});
            await page.waitForTimeout(1200);
          }
        }

        // Read the open message body from the second iframe.
        const mailFrame: Frame | null = page.frame({ name: 'ifmail' }) ?? null;
        if (mailFrame) {
          const body = (await mailFrame.locator('body').textContent().catch(() => '')) ?? '';
          const otp = extractOtp(body);
          if (otp) {
            console.log(`   ✅ OTP: ${otp} (attempt ${attempt}/${attempts})`);
            return otp;
          }
        }
        console.log(`   🔄 Attempt ${attempt}/${attempts} — OTP not yet available`);
      } catch (e) {
        console.log(`   ⚠️  Attempt ${attempt}/${attempts} error: ${(e as Error).message.split('\n')[0]}`);
      }
      if (attempt < attempts) await sleep(jitter(intervalMs));
    }
  } finally {
    await page.close().catch(() => {});
  }

  throw new Error(
    `Could not fetch OTP for ${email} from yopmail after ${attempts} attempts ` +
      `(likely yopmail rate-limiting/captcha under heavy same-IP usage — space out runs or use an API mailbox)`,
  );
}
