import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getOrg } from '../../src/config/orgs';
import { createOrgUser, type CreatedUser } from '../../src/utils/user-factory';

const FILE = resolve(__dirname, '../../created-users.txt');

/** Production Ekshamata is provisioned through sphere, so both mean production. */
const PROD_HOST = 'ekshamata.aastrika.org';
const canonicalHost = (host: string) => (host === 'sphere.aastrika.org' ? PROD_HOST : host);

/** The portal this run is pointed at — accounts do not work across backends. */
function targetHost(): string {
  try {
    return canonicalHost(new URL(process.env.BASE_URL || `https://${PROD_HOST}`).hostname);
  } catch {
    return PROD_HOST;
  }
}

function parseAll(): CreatedUser[] {
  if (!existsSync(FILE)) return [];
  return readFileSync(FILE, 'utf-8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const p = line.split('|').map((s) => s.trim());
      if (p.length < 6) return null;
      return {
        orgKey: p[1],
        designation: p[2],
        email: p[3],
        password: p[4],
        userId: p[5].replace(/^userId=/, ''),
        // Lines written before accounts were env-tagged were all made on
        // production, so that is what an absent env means.
        env: canonicalHost((p[6] ?? '').replace(/^env=/, '')) || PROD_HOST,
      };
    })
    .filter((u): u is CreatedUser & { env: string } => !!u && !!u.email);
}

/**
 * A user for (orgKey, designation).
 *
 * Provisions a FRESH user by default. Reusing accounts from created-users.txt
 * made the content checks unreliable: an old account's org mapping can have
 * changed, its password can have been rotated (CHO-MP failed with a 30s login
 * timeout), and any course it started shifts the very counts under test. A new
 * account always reflects what the org maps TODAY.
 *
 * Set REUSE_USERS=1 to reuse the newest matching account instead (faster, but
 * only sound when you know the account is clean).
 */
export async function getUserFor(orgKey: string, designation: string): Promise<CreatedUser> {
  if (process.env.REUSE_USERS === '1') {
    // Only accounts made on THIS environment: a production run handed a
    // STAGE- account fails at login, which reads as a broken portal rather than
    // the wrong account being picked.
    const here = targetHost();
    const match = parseAll()
      .filter((u) => u.orgKey === orgKey && u.designation === designation && (u as any).env === here)
      .pop();
    if (match) return match;
  }
  const org = getOrg(orgKey);
  const variant = org.designations.find((d) => d.designation === designation) ?? org.designations[0];
  return createOrgUser(orgKey, variant);
}
