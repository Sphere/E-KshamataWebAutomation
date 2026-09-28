/**
 * Secret redaction for shareable reports.
 *
 * Playwright records the literal argument of every action, so a password fill
 * lands in the step list as: Fill "Sunbird@123" locator('input[type=password]').
 * These reports are meant to be handed to clients, so anything sensitive is
 * masked before it reaches the HTML / PDF / Excel.
 */
const MASK = '••••••';

/** Env vars whose values must never appear in a report. */
const SECRET_ENV_KEYS = [
  'EKSHAMATA_PASSWORD',
  'EKSHAMATA_USER_PASSWORD',
  'TEST_USER_PASSWORD',
  'SPHERE_API_TOKEN',
  'SPHERE_STAGING_API_TOKEN',
  'SPHERE_STAGING_API_COOKIE',
  'SPHERE_API_COOKIE',
  'SESSION_COOKIE',
  'CONNECT_SID',
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Values worth masking: real secrets from the environment (ignore trivial ones). */
function secretValues(): string[] {
  const out = new Set<string>();
  for (const k of SECRET_ENV_KEYS) {
    const v = process.env[k];
    if (v && v.trim().length >= 4) out.add(v.trim());
  }
  // The suite's well-known fixed test password, even when not in this env.
  out.add('Sunbird@123');
  out.add('Sample@123');
  return [...out];
}

const SECRETS = secretValues();

/** ESC[<n>m colour codes Playwright embeds in titles and messages. */
const ANSI = new RegExp(String.fromCharCode(27) + '\\[\\d+m', 'g');

export function redact(text: string): string {
  if (!text) return text;
  let s = text.replace(ANSI, '');

  // 1. Known secret values, wherever they appear.
  for (const v of SECRETS) s = s.split(v).join(MASK);

  // 2. Any Fill into a password field, whatever the value.
  s = s.replace(
    /Fill\s+"[^"]*"(\s+.*?input\[type=(?:"|&quot;|')?password)/gi,
    `Fill "${MASK}"$1`,
  );

  // 3. OTP codes echoed in logs (they are single-use, but still noise for a client).
  s = s.replace(/\b(OTP|otp)\s*[:=]\s*(\d{4,8})\b/g, `$1: ${MASK}`);

  return s;
}

/** Redaction for values that may be secrets themselves (e.g. an env dump). */
export function redactSecretList(): string[] {
  return SECRETS.map(() => MASK);
}

export { MASK };
