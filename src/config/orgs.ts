import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Playwright transpiles specs as CommonJS, so `__dirname` is available directly
// (no import.meta.url dance needed, unlike the WDIO/ESM mobile project).

export interface DesignationVariant {
  /** Designation value written into professionalDetails[0].designation. */
  designation: string;
  /** Email prefix for this variant, e.g. "ANM-MP" -> ANM-MP<seq>@yopmail.com. */
  emailPrefix: string;
}

export interface OrgConfig {
  /** Short key, also the test/script name (e.g. "BNRC"). */
  key: string;
  /** Full org name (display/reference only — the real `channel` is resolved from the org API by orgId). */
  name: string;
  /** organisationId — used on Assign Role. */
  orgId: string;
  /** One or more designation variants. One user is created per variant. */
  designations: DesignationVariant[];
  /** Filename (under src/config/profiles/) of the exact profileDetails JSON for this org. */
  profileFile: string;
  /** Where the user should land after login (used by post-login verification). */
  landingPage?: string;
}

/**
 * Org registry — replicated 1:1 from the Ekshamata mobile suite
 * (D:\Mobile automation\src\config\orgs.ts). Add a new org here + drop its
 * profile JSON in src/config/profiles/, then create tests/orgs/<KEY>.spec.ts
 * (copy BNRC.spec.ts).
 */
export const ORGS: Record<string, OrgConfig> = {
  BNRC: {
    key: 'BNRC',
    name: 'Bihar Nursing Registration Council',
    orgId: '014005962721189888281',
    designations: [{ designation: 'ANM-Student-Bihar', emailPrefix: 'BNRC-ANM' }],
    profileFile: 'BNRC.json',
    landingPage: 'Competency Homepage',
  },
  SIHFWUP: {
    key: 'SIHFWUP',
    name: 'State Institute of Health and Family Welfare, Department of Health & Family Welfare, UP',
    orgId: '0142443633580769283117',
    designations: [{ designation: 'Medical Officer-UP', emailPrefix: 'SIHFWUP-MO' }],
    profileFile: 'SIHFWUP.json',
    landingPage: 'Homepage', // 1 course mapped
  },
  MP: {
    key: 'MP',
    // `name` is display-only; the real channel is resolved from the org API by orgId
    // (MP's stored channel contains a non-breaking space, so it can't be hand-typed).
    name: 'Madhya Pradesh - National Health Mission',
    orgId: '0144238134833561601003',
    designations: [
      { designation: 'ANM-MP', emailPrefix: 'MP-ANM' },
      { designation: 'CHO-MP', emailPrefix: 'MP-CHO' },
    ],
    profileFile: 'MP.json',
    landingPage: 'Homepage', // 9 courses mapped
  },
  SHSB: {
    key: 'SHSB',
    name: 'State Health Society Bihar',
    orgId: '01403709013603123234776',
    designations: [
      { designation: 'ANM-Bihar', emailPrefix: 'SHSB-ANM' },
      { designation: 'CHO-Bihar', emailPrefix: 'SHSB-CHO' },
    ],
    profileFile: 'SHSB.json',
    landingPage: 'Homepage',
  },
  DMHUP: {
    key: 'DMHUP',
    name: 'Directorate of Medical Health (UP)',
    orgId: '014017257642377216440',
    designations: [{ designation: 'ANM-Outreach-UP', emailPrefix: 'DMHUP-ANM' }],
    profileFile: 'DMHUP.json',
    landingPage: 'Homepage',
  },
  DMHFWUP: {
    key: 'DMHFWUP',
    name: 'Department of Medical Health & Family Welfare (Uttar Pradesh)',
    orgId: '01400948801286144024329',
    designations: [
      { designation: 'Staff Nurse', emailPrefix: 'DMHFWUP-SN' },
      { designation: 'Zonal Nursing Faculty', emailPrefix: 'DMHFWUP-ZNF' },
      { designation: 'ANM_UP', emailPrefix: 'DMHFWUP-ANM_UP' },
      { designation: 'ANM-UP', emailPrefix: 'DMHFWUP-ANM-UP' },
    ],
    profileFile: 'DMHFWUP.json',
    landingPage: 'Homepage',
  },
  PVTBIHAR: {
    key: 'PVTBIHAR',
    name: 'Private (Bihar)',
    orgId: '01403708858877542434777',
    designations: [{ designation: 'ANM-BIHAR', emailPrefix: 'PVTBIHAR-ANM' }],
    profileFile: 'PVTBIHAR.json',
    landingPage: 'Homepage',
  },
  PVTUP: {
    key: 'PVTUP',
    name: 'Private (Uttar Pradesh)',
    orgId: '0144024277797191683752',
    designations: [
      { designation: 'ANM-UP', emailPrefix: 'PVTUP-ANM' },
      { designation: 'ANM_UP', emailPrefix: 'PVTUP-ANM_UP' },
    ],
    profileFile: 'PVTUP.json',
    landingPage: 'Homepage',
  },
  NHMUP: {
    key: 'NHMUP',
    name: 'National Health Mission (Uttar Pradesh)',
    orgId: '0144024313254133763751',
    designations: [
      { designation: 'ANM-Outreach-UP', emailPrefix: 'NHMUP-ANM' },
      { designation: 'ANM_UP', emailPrefix: 'NHMUP-ANM_UP' },
    ],
    profileFile: 'NHMUP.json',
    landingPage: 'Homepage',
  },
  NHMUP2: {
    key: 'NHMUP2',
    name: 'National Health Mission (UP)',
    orgId: '014017257506177024441',
    designations: [{ designation: 'ANM_UP', emailPrefix: 'NHMUP2-ANM_UP' }],
    profileFile: 'NHMUP2.json',
    landingPage: 'Homepage',
  },
  NHMMP: {
    key: 'NHMMP',
    name: 'Test NHM Madhya Pradesh',
    orgId: '014095108131266560969',
    designations: [{ designation: 'GNM-Test', emailPrefix: 'NHMMP-GNM' }],
    profileFile: 'NHMMP.json',
    landingPage: 'Homepage',
  },
  NHMMADHYA: {
    key: 'NHMMADHYA',
    name: 'NHM Madhya Pradesh',
    orgId: '014095104385122304968',
    designations: [{ designation: 'ANM/MPW', emailPrefix: 'NHMMADHYA-ANM' }],
    profileFile: 'NHMMADHYA.json',
    landingPage: 'Homepage',
  },
  TESTUP: {
    key: 'TESTUP',
    name: 'Test Uttar Pradesh',
    orgId: '013979705730662400309',
    designations: [{ designation: 'ANM-UP', emailPrefix: 'TESTUP-ANM' }],
    profileFile: 'TESTUP.json',
    landingPage: 'Competency Homepage',
  },
  TESTBIHAR: {
    key: 'TESTBIHAR',
    name: 'Test Bihar',
    orgId: '013936570871160832170',
    // This org carries the SAME roles under two spellings, so both are swept.
    //
    // The upper-case set came from the provisioning payload; the mixed-case set
    // from the role sheet. A designation is matched byte-for-byte when content is
    // mapped to it, so "ANM-BIHAR" and "ANM-Bihar" are not interchangeable — and
    // which one a real user gets decides what they see. Running both is how the
    // report shows whether they resolve to the same homepage or only one is live.
    designations: [
      { designation: 'ANM-BIHAR', emailPrefix: 'TESTBIHAR-ANM' },
      { designation: 'CHO-BIHAR', emailPrefix: 'TESTBIHAR-CHO' },
      { designation: 'ANM-STUDENT-BIHAR', emailPrefix: 'TESTBIHAR-ANMSTU' },
      { designation: 'ANM-FACULTY-BIHAR', emailPrefix: 'TESTBIHAR-ANMFAC' },
      // Mixed-case spellings from the role sheet.
      { designation: 'ANM-Bihar', emailPrefix: 'TESTBIHAR-ANMMC' },
      { designation: 'ANM-Student-Bihar', emailPrefix: 'TESTBIHAR-ANMSTUMC' },
      { designation: 'CHO-Bihar', emailPrefix: 'TESTBIHAR-CHOMC' },
    ],
    profileFile: 'TESTBIHAR.json',
    // landingPage intentionally unset — the sweep is what determines it.
  },
};

export function getOrg(key: string): OrgConfig {
  const org = ORGS[key];
  if (!org) throw new Error(`Unknown org "${key}". Known: ${Object.keys(ORGS).join(', ')}`);
  return org;
}

/** Loads the exact profileDetails JSON for an org. */
export function loadProfile(org: OrgConfig): any {
  const path = resolve(__dirname, 'profiles', org.profileFile);
  return JSON.parse(readFileSync(path, 'utf-8'));
}
