import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { type CreatedUser } from './user-factory';

// created-users.txt lives at the project root. Override with USERS_FILE if you
// keep the record elsewhere (e.g. point at the mobile project's copy).
const ROOT = resolve(__dirname, '../..');
const DEFAULT_FILE = resolve(ROOT, 'created-users.txt');

/**
 * One line of created-users.txt looks like:
 *   2026-07-15T07:16:40.578Z | BNRC | ANM-Student-Bihar | BNRC-ANM033@yopmail.com | Aastrika@123 | userId=ce24...
 */
function parseLine(line: string): CreatedUser | null {
  const parts = line.split('|').map((p) => p.trim());
  if (parts.length < 6) return null;
  const [, orgKey, designation, email, password, userIdField] = parts;
  if (!email || !password) return null;
  return {
    orgKey,
    designation,
    email,
    password,
    userId: userIdField.replace(/^userId=/, ''),
  };
}

/**
 * Returns a previously-created user for `orgKey` from created-users.txt.
 * By default returns the MOST RECENT matching user (last line). Set
 * USER_EMAIL in the env to pin a specific account regardless of org.
 */
export function getExistingUser(orgKey: string): CreatedUser {
  const file = process.env.USERS_FILE ? resolve(process.env.USERS_FILE) : DEFAULT_FILE;
  if (!existsSync(file)) {
    throw new Error(`No user record file at ${file} (set USERS_FILE or create ${DEFAULT_FILE}).`);
  }

  const lines = readFileSync(file, 'utf-8').split(/\r?\n/).filter(Boolean);
  const users = lines.map(parseLine).filter((u): u is CreatedUser => u !== null);

  const pinnedEmail = process.env.USER_EMAIL?.trim();
  if (pinnedEmail) {
    const match = users.filter((u) => u.email.toLowerCase() === pinnedEmail.toLowerCase()).pop();
    if (!match) throw new Error(`USER_EMAIL="${pinnedEmail}" not found in ${file}.`);
    return match;
  }

  const match = users.filter((u) => u.orgKey === orgKey).pop();
  if (!match) throw new Error(`No existing user for org "${orgKey}" in ${file}.`);
  return match;
}
