import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Auto-load .env at startup so process.env.* works in tests.
dotenv.config({ path: path.resolve(__dirname, '.env') });

export default defineConfig({
  testDir: './tests',

  // ── Timing ─────────────────────────────────────────────────────
  timeout: 120_000, // 2 min per test ceiling
  expect: { timeout: 10_000 },

  // ── Execution mode ─────────────────────────────────────────────
  // Signup/login flows are stateful and provision real users — run serially.
  fullyParallel: false,
  workers: 1,
  retries: 0,

  reporter: [
    ['list'],
    ['./reporters/brand-html-reporter.ts'], // branded, self-contained HTML → brand-reports/
    ['./reporters/excel-reporter.ts'],      // detailed Excel → test-reports/
    ['./reporters/run-report.ts'],          // full HTML + PDF (every step/log) → test-reports/run-reports/
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],

  // ── Browser/page defaults ──────────────────────────────────────
  use: {
    // Localhost by default (local Ekshamata web dev server). Point at
    // https://ekshamata.aastrika.org via .env to run against the live portal.
    baseURL: process.env.BASE_URL ?? 'https://ekshamata.aastrika.org',
    headless: process.env.HEADLESS === 'true',
    // viewport:null lets the page fill the real (maximized) window instead of a
    // fixed 1280×800 box — pairs with --start-maximized below for full screen.
    viewport: null,
    actionTimeout: 15_000,
    navigationTimeout: 60_000,
    // 'on' = capture for EVERY test, not just failures — the branded/PDF report
    // then shows visual evidence for passing runs too (each image is embedded).
    screenshot: 'on',
    video: 'retain-on-failure',
    trace: 'on-first-retry',

    launchOptions: {
      // SLOW_MO=250 pauses a quarter-second between actions so a headed run can
      // actually be followed by eye. 0 (the default) changes nothing.
      slowMo: Number(process.env.SLOW_MO || 0),
      args: [
        '--start-maximized',            // open the browser window full screen
        '--disable-blink-features=AutomationControlled',
        '--no-default-browser-check',
        '--no-first-run',
        '--disable-popup-blocking',
      ],
    },
  },

  projects: [
    // viewport:null makes the page fill the maximized window (full screen). The
    // Desktop Chrome device also sets deviceScaleFactor, which Playwright forbids
    // with a null viewport — so clear it (and isMobile) alongside.
    // Per-org login suites (provision a fresh user each run).
    {
      name: 'orgs',
      testMatch: '**/orgs/**/*.spec.ts',
      use: { ...devices['Desktop Chrome'], viewport: null, deviceScaleFactor: undefined, isMobile: false },
    },
    // Main UI/E2E suite (smoke + login). Excludes the org suites.
    {
      name: 'Chrome',
      // Exclude org suites and the underscore-prefixed helper specs (interactive
      // discovery / probes) — those are launched on demand, not part of a suite.
      testIgnore: ['**/orgs/**', '**/_*.spec.ts'],
      use: { ...devices['Desktop Chrome'], viewport: null, deviceScaleFactor: undefined, isMobile: false },
    },
    // On-demand helper specs (interactive discovery / probes). Run explicitly by
    // the launchers with --project=helpers; never part of a normal suite run.
    {
      name: 'helpers',
      testMatch: '**/_*.spec.ts',
      use: { ...devices['Desktop Chrome'], viewport: null, deviceScaleFactor: undefined, isMobile: false },
    },
  ],
});
