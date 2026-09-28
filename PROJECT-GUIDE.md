# Ekshamata Web Automation — Project Guide

End-to-end Playwright automation for the **Ekshamata** health-worker learning
portal (`https://ekshamata.aastrika.org`). This guide documents everything in the
project: what each file does, every command, how it differs from the Sphere web
suite, Tarento engineering/brand guidelines, the roadmap to a production-grade
platform, and how to put it on GitHub.

> **Key platform fact:** `ekshamata.aastrika.org` is a **branded shell that runs
> on the Sphere instance**. Its JS bundle and `assets/*` config hard-code
> `https://sphere.aastrika.org`, so **after login the authenticated app lives on
> the Sphere host**. This is by design, not a bug — tests account for it.

---

## 1. What this suite does

| Capability | Spec | Status |
|---|---|---|
| Provision org users (per role) + verify login | `tests/orgs/*.spec.ts` → `orgLoginSuite` | ✅ Working |
| Validate homepage type & mapped content per org | `tests/org-content.spec.ts` | ✅ Working |
| Climb a competency's self-assessments (answer + submit) | `tests/competency-stepper.spec.ts` | ⚠️ Answering works; **submit blocked** (see §8) |
| Smoke / single login | `tests/smoke.spec.ts`, `tests/login.spec.ts` | ✅ Working |

---

## 2. Project structure (file-by-file)

```
EkshamataWebAutomation/
├─ .env                      # Target env + provisioning creds (NOT committed)
├─ .env.example             # Template for .env
├─ playwright.config.ts     # Projects (Chrome, orgs), baseURL, timeouts, reporters
├─ package.json             # npm scripts (see §4)
├─ tsconfig.json
│
├─ src/                     # Non-test logic (APIs, config, utilities)
│  ├─ api/
│  │  └─ Ekshamata-api.ts    # user-provisioning API client (Sphere backend)
│  │                         #   createUser / assignRole / updateProfile / getOrgChannel
│  │                         #   Auth: SPHERE_API_TOKEN + SPHERE_API_COOKIE (EXPIRING)
│  ├─ config/
│  │  ├─ orgs.ts             # ORG REGISTRY — key, orgId, designations[], profileFile
│  │  └─ profiles/*.json     # Exact profileDetails payload per org (10 files)
│  └─ utils/
│     ├─ user-factory.ts     # createOrgUser(orgKey, variant) — full 3-step onboarding;
│     │                      #   records to created-users.txt + last-created-user.json
│     ├─ user-store.ts       # getExistingUser(orgKey) — read back a created user
│     └─ answer-key.ts       # fetchAnswerKey(quizId) — real S3 answer key (questionset
│                            #   hierarchy → artifactUrl → quiz.json). Exposes `pool`.
│
├─ tests/
│  ├─ helpers/
│  │  ├─ login.ts            # loginWithPassword() + openLoginScreen() (clears stale
│  │  │                      #   sessions so it lands on the anonymous login)
│  │  ├─ orgLoginSuite.ts    # Reusable per-org suite — ONE user PER designation role
│  │  ├─ session.ts          # openCompetencyHome() — auth then land on the home
│  │  └─ user-lookup.ts      # getUserFor(orgKey, designation) — reuse-or-provision
│  ├─ pages/                 # Page objects (POM)
│  │  ├─ competency-home.page.ts   # Learning-plan cards, expand, "Start Self Assessment"
│  │  ├─ my-courses.page.ts        # My Courses tabs: For You / Started / Completed;
│  │  │                            #   programCardCount() for PROGRAMS homepages
│  │  └─ self-assessment.page.ts   # Quiz player: per-page answer engine + submit
│  ├─ fixtures/
│  │  └─ org-content-expected.ts   # Expected homepage type + counts per org+role
│  ├─ orgs/                        # One line each: orgLoginSuite('<KEY>')
│  │  └─ BNRC | DMHUP | MP | NHMMADHYA | NHMMP | NHMUP | PVTBIHAR | PVTUP | SHSB | SIHFWUP
│  ├─ org-content.spec.ts          # THE content validator (§6)
│  ├─ competency-stepper.spec.ts   # THE competency climb (§7)
│  ├─ login.spec.ts | smoke.spec.ts
│  └─ _probe-fail.spec.ts          # Intentional-fail probe (report sanity)
│
├─ scripts/
│  ├─ run-course.mjs         # ⭐ complete a whole course, any environment (§4)
│  ├─ compare-env.mjs        # ⭐ prod vs staging, side by side (§4)
│  ├─ run-compare.mjs        # interactive picker for the comparison
│  └─ lib/env-*.mjs          # capture · diff · login · report for the above
├─ config/
│  ├─ compare-routes.json    # features + API endpoints compared
│  └─ compare-journeys.json  # flows walked step by step on both environments
├─ compare-reports/          # comparison output (NOT committed)
├─ created-users.txt        # Running log of every provisioned user (NOT committed)
├─ last-created-user.json   # Latest provisioned user (NOT committed)
└─ email-counters.json      # Per-prefix sequence counters (NOT committed)
```

### The 10 orgs and their roles
| Key | Org | Roles (designations) |
|---|---|---|
| BNRC | Bihar Nursing Registration Council | ANM-Student-Bihar |
| DMHUP | Directorate of Medical Health (UP) | ANM-Outreach-UP |
| SHSB | State Health Society Bihar | ANM-Bihar, **CHO-Bihar** |
| MP | Madhya Pradesh – NHM | ANM-MP, **CHO-MP** |
| SIHFWUP | State Institute of H&FW, UP | Medical Officer-UP |
| PVTBIHAR | Private (Bihar) | ANM-Bihar |
| PVTUP | Private (UP) | ANM-UP |
| NHMUP | NHM (UP) | ANM-Outreach-UP |
| NHMMP | Test NHM Madhya Pradesh | GNM-Test |
| NHMMADHYA | NHM Madhya Pradesh | ANM/MPW |

---

## 3. Setup

```powershell
cd D:\Automation\EkshamataWebAutomation
npm install
npx playwright install chromium
copy .env.example .env    # then fill in the values below
```

### `.env` (required)
```ini
# Target — PRODUCTION only (localhost is commented out)
BASE_URL=https://ekshamata.aastrika.org
HEADLESS=false

# Existing account for tests/login.spec.ts
EKSHAMATA_EMAIL=SHSB001@yopmail.com
EKSHAMATA_PASSWORD=Aastrika@123

# Sphere provisioning APIs — SESSION creds, they EXPIRE (refresh on 401/419)
SPHERE_API_TOKEN=<bearer token from DevTools>
SPHERE_API_COOKIE=connect.sid=<value from DevTools>
EKSHAMATA_USER_PASSWORD=Aastrika@123   # password set on every provisioned user
```

> **Refresh creds when provisioning returns 401/419:** grab a fresh
> `Authorization` bearer + `connect.sid` cookie from the browser DevTools
> (Network tab) while logged in, and paste into `.env`.

---

## 4. Commands (everything)

All from `D:\Automation\EkshamataWebAutomation`.

### npm scripts
```powershell
npm test                  # UI suite (smoke + login), --project=Chrome
npm run test:all          # everything (Chrome + orgs)
npm run test:orgs         # ALL org login suites — one user PER role, recorded to txt
npm run test:bnrc         # BNRC only, reusing an existing user
npm run test:org-content  # Homepage-type + mapped-content validation (all 12 org+role)
npm run smoke             # smoke.spec.ts
npm run login             # login.spec.ts (existing EKSHAMATA_EMAIL)
npm run run:stepper       # competency-stepper (COMPETENCY env picks which)
npm run report            # open the last HTML report
npm run run:course        # ⭐ complete a whole course (interactive: env → course → learner)
npm run run:course:prod   # ⭐ COURSE_NAME on production
npm run run:course:stage  # ⭐ COURSE_NAME on staging
npm run courses:list      # what courses exist (add :stage for staging)
npm run test:badge        # ⭐ is the "N Badges Earned" pill on the Account page?
npm run run:certificate   # ⭐ consume a certificate course end to end, then download it
npm run run:certificate:only   # the download alone, for a course already complete
npm run courses:list -- --certificates   # only the courses that end in a certificate
npm run compare           # ⭐ prod vs staging side by side (interactive)
npm run compare:all       # ⭐ same, signed in, everything, opens the report
```

### ⭐ Compare production vs staging (side by side)

`scripts/compare-env.mjs` loads every feature in `config/compare-routes.json` on **both** environments at the same time, in two browser contexts, and reports what differs — **UI** (screenshots left/right, pixel diff, missing headings/buttons/fields/links, broken images, copy drift), **function** (HTTP status, redirects, blank pages, console + uncaught JS errors, failing requests, settle time, build hash) and **data** (API parity, and which courses exist on one environment but not the other). Output is a branded side-by-side HTML report + JSON summary in `compare-reports/`, and it **exits 1 when anything blocking is found**, so it can gate a release.

```powershell
# ⭐ signed in on both sides with the same production-created account
npm run compare:all

# interactive: which two envs → signed in? → WHICH created account → features → options
npm run compare

# any flag skips the prompts entirely
npm run compare:public                 # public pages only, no login
npm run compare:users                  # list the accounts it can sign in with
npm run compare:journeys               # every journey, step by step, signed in
npm run compare:login                  # just the login journey (public)
npm run compare:local                  # production vs http://localhost:3000

# pick the account (both sides use the SAME one)
npm run compare -- --auth --org SHSB
npm run compare -- --auth --user SHSB-CHO035@yopmail.com

# scoping and tuning
npm run compare -- --auth --only competency,my-courses   # match route id or name
npm run compare -- --auth --route /app/user/my_courses   # a one-off path
npm run compare -- --auth --headed                       # watch it run
npm run compare -- --auth --threshold 1.5                # ignore visual diffs under 1.5%
npm run compare -- --auth --no-catalogue                 # skip catalogue parity (faster)
npm run compare -- --auth --refresh                      # re-login + re-fetch the catalogue
npm run compare -- --auth --a https://ekshamata.aastrika.org --b https://ekshamata-staging.aastrika.org
```

Defaults are `--a https://ekshamata.aastrika.org` and `--b https://ekshamata-staging.aastrika.org`, so prod vs staging needs no URLs.

**Which account signs in.** Users are provisioned on **production**, so **both** sides sign in with the same production-created account — the comparison is then environment vs environment, not person vs person. Order: `PROD_EMAIL`/`STAGING_EMAIL` (per env) → `COMPARE_EMAIL` → the accounts in `created-users.txt` (`--user` / `--org`, else newest first) → `EKSHAMATA_EMAIL`. Because provisioning runs append to that ledger live, an account created in the last five minutes may still be half-made: those are tried *after* the settled ones, and the run moves down the list until a login succeeds. Set `STAGING_EMAIL`/`STAGING_PASSWORD` to sign the right-hand side in as a staging-native account instead.

Add a feature by adding an entry to `config/compare-routes.json`, or a flow to `config/compare-journeys.json` — no code change. Steps are read-only by design; anything that writes real data is marked `"writes": true` and is skipped unless the run is started with `--allow-writes`.

### Create users (provision)
```powershell
# All orgs, every role (SHSB→ANM-Bihar+CHO-Bihar, MP→ANM-MP+CHO-MP, etc.)
npm run test:orgs

# A single org (creates every role of that org)
npx playwright test tests/orgs/SHSB.spec.ts --project=orgs --headed
npx playwright test tests/orgs/MP.spec.ts   --project=orgs --headed

# Reuse the latest existing users instead of provisioning fresh
cross-env USE_EXISTING_USER=1 npm run test:orgs
```
Credentials are appended to **`created-users.txt`**:
`timestamp | ORG | designation | email | password | userId=...`

### Validate org content (For You / Programs / Competency)
```powershell
npm run test:org-content                                   # all 12 org+role checks
npx playwright test tests/org-content.spec.ts --grep "MP|SHSB" --project=Chrome --headed
cross-env PROVISION=1 npm run test:org-content             # force-mint fresh users
```

### Competency stepper
```powershell
$env:COMPETENCY="Normal delivery"; $env:LEVELS="5"; npm run run:stepper
```

### ⭐ Complete a whole course

`tests/course-complete.spec.ts` opens one course and finishes **every** module — PDFs, videos, content pages and in-course assessments — through the shared `CoursePlayer` (the same player the competency runner drives), answering assessments from the real, token-free answer key. The course name is resolved to a `do_id` against the **live catalogue of whichever environment `BASE_URL` points at**, so the same command works on production and staging even though the two hold different course sets (438 vs 393 today).

```powershell
# interactive: environment → course → learner → headed
npm run run:course

# a named course, per environment
$env:COURSE_NAME="Administration of drugs through IV"; npm run run:course:prod
$env:COURSE_NAME="Administration of drugs through IV"; npm run run:course:stage

# what is there to run? (the two environments differ)
npm run courses:list
npm run courses:list:stage

# no prompts
npm run run:course -- --course "Administration of drugs through IV"
npm run run:course -- --stage --course "Administration of drugs through IV" --headless

# certificates
npm run run:certificate                          # ⭐ consume a certificate course, then download it
npm run run:certificate -- --stage --course "Lactation management"   # same, no prompts
npm run run:certificate:only                     # course already complete — just fetch the file
npm run courses:list -- --certificates           # which courses end in one
npm run run:course -- --course "<name>" --no-certificate   # finish only, skip it
```

**The certificate.** A completed course run now ends by downloading the certificate to `test-reports/certificates/Certificate_<course>.<ext>`, and attaches it to the report.

Three outcomes, kept apart on purpose:

| What the run says | What it means |
|---|---|
| `🏅 certificate saved → …` | downloaded |
| `issues no certificate` | `issueCertification=false` — the course never offers one, so the course run still passes. Most courses are like this: about 30 of the 242 live courses issue certificates. |
| `still generating` / `no control` | the course DOES promise one and the learner did not get it — the run fails |

Generation is asynchronous. On staging a course that had just been finished showed neither 100% nor a Certificate action on its TOC, and both were there minutes later — so the step re-opens the TOC `CERTIFICATE_ATTEMPTS` (5) times, `CERTIFICATE_WAIT_SEC` (30) apart. If it still was not ready, fetch it on its own with `npm run run:certificate:only` rather than re-running the course. `CERTIFICATE=0` skips the step entirely.

**Inputs.** `COURSE_NAME` (exact title first, then substring — an ambiguous name lists the matches and stops) or `COURSE_ID` to skip the lookup. `MAX_MODULES` caps the module count (60), `COURSE_TIMEOUT_MIN` the run (90 min).

**Which learner.** `COURSE_EMAIL`/`COURSE_PASSWORD` → `EKSHAMATA_EMAIL`/`EKSHAMATA_PASSWORD` from `.env` → a user for `$env:ORG`. The `.env` account is the default because it exists on **both** backends; accounts created through the API on production do not always sign in on staging (§8).

### Useful flags (append to any `npx playwright test`)
```
--headed            # watch it run
--debug             # Playwright Inspector
--grep "pattern"    # run tests whose title matches
--project=Chrome    # UI suite   |   --project=orgs   # org login suites
--list              # list tests without running (fast compile check)
npx playwright show-report
```

---

## 5. `org-content.spec.ts` — the content validator

Per **org + role**, logs in and asserts the correct homepage renders. Four types
(source of truth = `tests/fixtures/org-content-expected.ts`):

| Type | Orgs | Assertion |
|---|---|---|
| `competency` | BNRC, DMHUP, PVTBIHAR, SHSB/ANM-Bihar | Learning Plan on home **+ For You = 73** |
| `courses` | SIHFWUP | My Courses ▸ For You = 1 |
| `programs` | MP (4), NHMMP (2) | Home PROGRAMS program-card count |
| `none` | NHMUP | For You = 0 |
| `competency` (plan only) | PVTUP | Learning Plan on home |
| `review` (log actual) | NHMMADHYA, SHSB/CHO-Bihar | Loose check; prints real value |

To add course-name checks, set `names: ['Course Title', …]` on a role in the fixture.

---

## 6. `competency-stepper.spec.ts` — the competency climb

`$env:COMPETENCY="<name>"` → finds the competency card, expands it, opens
"Start Self Assessment", and for **each level**: fetches the real S3 answer key,
answers **one question per page** (match on-screen question → pool → correct
option), then Submits. Works up to submit — see the known blocker in §8.

---

## 7. How this differs from the Sphere web suite (`SphereWebAutomation`)

| Aspect | Ekshamata (this) | Sphere (`SphereWebAutomation`) |
|---|---|---|
| Auth model | Provision fresh users via Sphere API + **UI password login** | Standard creds (`sphereid041`), or **CDP** attach on localhost |
| Local runs | Prod only (branded shell → sphere host) | **CDP** attach to a logged-in Chrome/Edge on `:9222` (localhost mirror) |
| Answer key source | Questionset hierarchy → S3, **needs bearer token** (expires) | **Content hierarchy → S3, org headers only** (no token) |
| Poisoned key | Handled in stepper via real S3 pool | `fetchRealAnswerKey()` bypasses poisoned copy via hierarchy |
| Quiz player DOM | `input.mdc-radio__native-control` + `button.btn-active` | `mat-radio-group` / `mat-radio-button` |
| Scope | **Multi-org** (10 orgs, roles, profiles, content mapping) | **Single competency** completion by name |
| Submit | **Blocked** for fresh non-enrolled users (§8) | Works (uses an enrolled standard user) |
| Entry helpers | `npm` scripts | `run-competency.ps1`, `start-cdp-chrome.ps1`, `start-cdp-edge.ps1` |

**Sphere quick reference** (sibling project `D:\Automation\SphereWebAutomation`):
```powershell
cd D:\Automation\SphereWebAutomation
.\run-competency.ps1 "Care of the newborn"          # prod, standard creds
npm run cdp:edge                                      # launch clean CDP Edge (:9222)
.\run-competency.ps1 "Care of the newborn" -Local     # localhost over CDP
```

---

## 8. Known issue — competency submit ("Unable to submit")

The stepper answers **all questions correctly** and clicks Submit, but the server
returns **"Something went wrong! Unable to submit."** Root cause: the stepper
provisions a **brand-new user** who is **not enrolled in the competency's course
batch** (the quiz URL carries a `batchId`). A non-enrolled user can start/answer
but cannot submit a result.

**Fix options (pick one):**
1. **Enroll before assessment** — call the platform enroll API (course/batchId) in
   provisioning, then submit succeeds.
2. **Use an already-enrolled account** for the stepper.
3. **Mirror the mobile flow** if it enrolls on a different path.

---

## 9. Tarento engineering & brand guidelines

### Engineering standards
- **Page Object Model** — selectors live in `tests/pages/*.page.ts`, never in specs.
- **Config-driven data** — org data in `src/config`, expected values in
  `tests/fixtures`; specs contain logic only.
- **Web-first assertions** — prefer `expect(locator).toBeVisible()` /
  `expect.poll()` over fixed `waitForTimeout` (a cleanup target — see §10).
- **Deterministic naming** — email prefixes per org+role (`SHSB-CHO`, `MP-CHO`),
  sequence counters persisted.
- **Independent tests** — fresh context + login each; never `mode:'serial'` for
  independent checks (a failure must not skip the rest).
- **Secrets stay in `.env`** — never commit tokens/cookies/user records.
- **Idempotent + logged** — every provisioned user is recorded; every validation
  logs `actual vs expected`.

### Brand (for any HTML reports / dashboards / slides)
- **Palette 80 / 15 / 5** — Navy (primary, 80%) · Teal (secondary, 15%) ·
  Gold (accent, 5%).
- **Layout** — generous whitespace, clear hierarchy, single accent per view.
- **Omit the logo** in generated artifacts.
- Apply this to the branded HTML reporter (roadmap §10) and any status dashboards.

---

## 10. Roadmap — to a production-grade platform

**Reliability**
- [ ] Replace fixed `waitForTimeout` calls with web-first assertions / `expect.poll`.
- [ ] Add `retries: 1` in CI; `trace: 'on-first-retry'`, `video/screenshot: on failure`.
- [ ] Centralize selectors; add data-testids where the app allows.

**Auth & data**
- [ ] **Fix competency submit** (enrollment) — §8.
- [ ] Drop the **expiring bearer token**: port Sphere's org-header/no-auth key fetch.
- [ ] Automate creds refresh, or move to a service account / longer-lived token.
- [ ] **Data hygiene** — provisioning creates real prod users each run; add cleanup
      or a dedicated test tenant.

**Coverage & reporting**
- [ ] Branded HTML reporter (Tarento palette, §9) like the Sphere suite has.
- [ ] Excel/email report hooks for scheduled runs.
- [ ] Cross-browser (Chromium + WebKit) for the read-only validations.
- [ ] Tag suites (`@smoke`, `@content`, `@provision`) for selective CI runs.

**Engineering**
- [ ] ESLint + Prettier + `tsc --noEmit` gate; TypeScript `strict`.
- [ ] Lock expected values in `org-content-expected.ts` (resolve the `review` items:
      NHMMADHYA For You, SHSB/CHO-Bihar, MP/CHO-MP).
- [ ] Parallelize the read-only content checks (they're independent).

---

## 11. Add to GitHub (future)

### One-time
```powershell
cd D:\Automation\EkshamataWebAutomation
git init
git branch -M main
```

### `.gitignore` (create this — never commit secrets or generated data)
```gitignore
node_modules/
/.env
/created-users.txt
/last-created-user.json
/email-counters.json
/playwright-report/
/blob-reports/
/test-results/
/.auth/
*.log
```
> Keep `.env.example` (committed) as the template; keep `.env` **out** of git.

### First commit & push
```powershell
git add .
git commit -m "Ekshamata web automation: org provisioning, content validation, competency stepper"
gh repo create ekshamata-web-automation --private --source . --remote origin
git push -u origin main
# (or, without gh: create the empty repo on github.com, then:)
# git remote add origin https://github.com/<org>/ekshamata-web-automation.git
# git push -u origin main
```

### CI (GitHub Actions) — `.github/workflows/e2e.yml`
```yaml
name: e2e
on: [workflow_dispatch, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run test:org-content
        env:
          BASE_URL: https://ekshamata.aastrika.org
          HEADLESS: 'true'
          SPHERE_API_TOKEN: ${{ secrets.SPHERE_API_TOKEN }}
          SPHERE_API_COOKIE: ${{ secrets.SPHERE_API_COOKIE }}
          EKSHAMATA_USER_PASSWORD: ${{ secrets.EKSHAMATA_USER_PASSWORD }}
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: playwright-report, path: playwright-report/ }
```
- Store `SPHERE_API_TOKEN`, `SPHERE_API_COOKIE`, `EKSHAMATA_USER_PASSWORD` as
  **GitHub Actions secrets** (Settings → Secrets and variables → Actions).
- Enable **branch protection** on `main` (require PR + passing checks).

---

## 12. Quick reference — most-used commands

```powershell
# Complete a whole course (prod or stage)
$env:COURSE_NAME="Administration of drugs through IV"; npm run run:course:prod

# Compare production vs staging, signed in, open the report
npm run compare:all

# Create all org users (every role)      → created-users.txt
npm run test:orgs

# Validate homepage type + mapped content for all orgs
npm run test:org-content

# One org, both roles
npx playwright test tests/orgs/SHSB.spec.ts --project=orgs --headed

# Competency climb
$env:COMPETENCY="Normal delivery"; npm run run:stepper

# Open last report
npx playwright show-report
```
