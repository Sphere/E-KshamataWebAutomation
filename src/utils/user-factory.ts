import { appendFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getOrg, loadProfile, type DesignationVariant } from '../config/orgs';
import { createUser, assignRole, updateProfile, getOrgChannel, IS_STAGING } from '../api/Ekshamata-api';

// Project-root record files (Playwright runs from the project root).
const ROOT = resolve(__dirname, '../..');
/** Human-readable running log of every user created. */
const LOG_FILE = resolve(ROOT, 'created-users.txt');
/** Latest created user, machine-readable. */
const LAST_FILE = resolve(ROOT, 'last-created-user.json');
/** Per-email-prefix running counter, e.g. { "SHSB-ANM": 2 }. */
const COUNTER_FILE = resolve(ROOT, 'email-counters.json');

export interface CreatedUser {
  orgKey: string;
  designation: string;
  email: string;
  password: string;
  userId: string;
  /** Host of the backend this account was created on — they are NOT shared. */
  env?: string;
}

/**
 * Appends the created user to created-users.txt and overwrites
 * last-created-user.json.
 *
 * `env=<host>` is a SEVENTH field, appended after userId: production and
 * staging are separate backends, so an account only works on the one it was
 * made on, and a reader has to be able to tell which. Everything that parses
 * this file reads fields by index, so older lines (without it) still work.
 */
function record(user: CreatedUser): void {
  const line =
    `${new Date().toISOString()} | ${user.orgKey} | ${user.designation} | ${user.email} | ` +
    `${user.password} | userId=${user.userId} | env=${user.env ?? ''}\n`;
  appendFileSync(LOG_FILE, line, 'utf-8');
  writeFileSync(LAST_FILE, JSON.stringify(user, null, 2), 'utf-8');
}

/**
 * The marker stamped into a new account's address and first name so the
 * environment it belongs to is obvious at a glance:
 *
 *   production   BNRC-ANM007@yopmail.com          Aastrika User
 *   staging      STAGE-BNRC-ANM001@yopmail.com    Stage User
 *
 * Production stays untagged so its long-standing addresses keep their shape.
 * USER_ENV_TAG overrides the marker; USER_ENV_TAG=none turns it off.
 */
export function envTag(): string {
  const explicit = (process.env.USER_ENV_TAG || '').trim();
  if (explicit) return /^none$/i.test(explicit) ? '' : explicit.toUpperCase();
  return IS_STAGING ? 'STAGE' : '';
}

/** "STAGE" → "Stage" — the first name the tagged account is created with. */
function tagName(tag: string): string {
  return tag ? tag.charAt(0).toUpperCase() + tag.slice(1).toLowerCase() : 'Aastrika';
}

/**
 * The PORTAL this account can sign in to — which is what `env=` has to record.
 *
 * NOT the provisioning API's host: production Ekshamata is served by the same
 * backend as Sphere, so the API base is sphere.aastrika.org while the portal is
 * ekshamata.aastrika.org. Recording the API host made accounts invisible to
 * every lookup that asks "what can sign in to ekshamata.aastrika.org?".
 */
function portalHost(): string {
  try {
    return new URL(process.env.BASE_URL || 'https://ekshamata.aastrika.org').hostname;
  } catch (e) {
    return 'ekshamata.aastrika.org';
  }
}

/**
 * Returns the next zero-padded sequence number for an email prefix and persists
 * it, so emails increment across runs: SHSB-ANM001, SHSB-ANM002, ...
 */
function nextSeq(prefix: string): string {
  return String(bumpCounter(prefix, 1)).padStart(3, '0');
}

/** Advance a prefix counter by `by` and persist it; returns the new value. */
function bumpCounter(prefix: string, by: number): number {
  const counters: Record<string, number> = existsSync(COUNTER_FILE)
    ? JSON.parse(readFileSync(COUNTER_FILE, 'utf-8'))
    : {};
  const next = (counters[prefix] ?? 0) + by;
  counters[prefix] = next;
  writeFileSync(COUNTER_FILE, JSON.stringify(counters, null, 2), 'utf-8');
  return next;
}

/**
 * Runs the full 3-step onboarding for ONE designation variant and returns the
 * fresh login creds: create user -> assign PUBLIC role (org id) -> update profile.
 * If `variant` is omitted, the org's first designation is used.
 */
export async function createOrgUser(
  orgKey: string,
  variant?: DesignationVariant,
): Promise<CreatedUser> {
  const org = getOrg(orgKey);
  const v = variant ?? org.designations[0];
  const password = process.env.EKSHAMATA_USER_PASSWORD || 'Aastrika@123';
  // Resolve the exact channel from the org API (avoids invisible-char mismatches).
  const channel = await getOrgChannel(org.orgId);

  // The email is prefix+sequence; if the counter drifted behind actual usage
  // (manual signups + many runs), the address already exists. Retry, and every
  // few misses JUMP the counter ahead to escape a used cluster quickly instead
  // of crawling +1 at a time.
  // Tagged per environment, and counted per environment too — otherwise the
  // staging and production sequences would share one counter and leave gaps in
  // both. STAGE-BNRC-ANM001 is the first staging BNRC user regardless of how
  // many exist on production.
  const tag = envTag();
  const prefix = tag ? `${tag}-${v.emailPrefix}` : v.emailPrefix;
  const firstName = tagName(tag);

  const MAX_ATTEMPTS = 40;
  let email = '';
  let userId = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    email = `${prefix}${nextSeq(prefix)}@yopmail.com`;
    try {
      userId = await createUser({ email, firstName, lastName: 'User', password, channel, organisationId: org.orgId });
      break;
    } catch (err: any) {
      if (/email already exists/i.test(String(err?.message ?? err)) && attempt < MAX_ATTEMPTS) {
        // after every 5 sequential collisions, leap ahead by 15–35 to clear the cluster
        if (attempt % 5 === 0) bumpCounter(prefix, 15 + Math.floor(Math.random() * 20));
        continue;
      }
      throw err;
    }
  }

  await assignRole(userId, org.orgId, ['PUBLIC']);

  // Start from the org's exact profile, then stamp this variant's designation.
  const profile = loadProfile(org);
  const prof = profile?.profileReq?.professionalDetails?.[0];
  if (prof) prof.designation = v.designation;
  await updateProfile(userId, profile);

  const user: CreatedUser = {
    orgKey: org.key, designation: v.designation, email, password, userId,
    env: portalHost(),
  };
  record(user);
  console.log(`[user] created ${email} (${v.designation}) on ${user.env}`);
  return user;
}

/** Creates one user per designation variant configured for the org. */
export async function createOrgUsers(orgKey: string): Promise<CreatedUser[]> {
  const org = getOrg(orgKey);
  const users: CreatedUser[] = [];
  for (const v of org.designations) {
    users.push(await createOrgUser(orgKey, v));
  }
  return users;
}
