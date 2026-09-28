# Ekshamata Web Automation

Playwright + TypeScript automation for the **Ekshamata web portal**
(`https://ekshamata.aastrika.org`, home at `/page/home`).

Ekshamata and Sphere are **separate** web apps that share some backend
(Sunbird-based) plumbing, so this is a standalone project — not part of
`SphereWebAutomation`. The test **data** (org registry, user provisioning,
credentials, login flow) is replicated 1:1 from the Ekshamata **mobile** suite
at `D:\Mobile automation` (`tests/ekshamata`, `src/config/orgs.ts`,
`src/utils/user-factory.ts`, `src/api/Ekshamata-api.ts`).

Because the Ekshamata Android app is a Capacitor WebView wrapping this same web
app, the mobile DOM selectors apply here unchanged (`#loginId`,
`input[type="password"]`, `#form-login button`, the "By Password" radio, and
routes `/app/login`, `/app/new-tnc`, `/app/toc/`).

## Setup

```bash
cd "D:\Automation\EkshamataWebAutomation"
npm install
npx playwright install chromium
cp .env.example .env   # then fill in values (an .env is already provided)
```

### Environment (`.env`)

- `BASE_URL` — **defaults to `http://localhost:3000`** (local dev server). Set to
  `https://ekshamata.aastrika.org` to run against the live portal.
- `EKSHAMATA_EMAIL` / `EKSHAMATA_PASSWORD` — an existing account for the plain
  login test.
- `SPHERE_API_TOKEN` / `SPHERE_API_COOKIE` — session creds for the Sphere
  provisioning APIs (used only by the per-org suites). **These expire** —
  refresh from Postman / DevTools when calls start returning 401/419.

## Running

```bash
npm run smoke        # home page loads + login entry visible (headed)
npm run login        # password login with EKSHAMATA_EMAIL/PASSWORD (headed)
npm test             # smoke + login (Chrome project)
npm run test:orgs    # per-org: provision a fresh user, then log in (10 orgs)
npm run test:bnrc    # BNRC against PROD, reusing an existing user from the txt file
npm run report       # open the last HTML report
```

### Org-suite auth modes

The per-org suites (`tests/orgs/*`) pick how to get a user and how to log in:

- **Provision fresh (default):** creates a new user via the Sphere APIs.
- **Reuse existing user** — `USE_EXISTING_USER=1`: reads the most recent account
  for the org from `created-users.txt` (or pin one with `USER_EMAIL=...`).
  No provisioning creds needed.

> Login doesn't work on localhost, so run the org suites against **production**
> (`BASE_URL=https://ekshamata.aastrika.org`) — that's what `npm run test:bnrc`
> does. The scaffold stays ready for localhost once a working build is deployed.
>
> Note: injecting a browser session cookie does **not** authenticate you on the
> current localhost — its dev server proxies APIs with its own fixed server-side
> session, so it always runs as that pre-logged-in user regardless of cookies.

## Layout

```
src/
  api/sphere-api.ts        Sphere provisioning client (createUser/assignRole/updateProfile)
  config/orgs.ts           Org registry (BNRC, MP, SHSB, …) — mirrors mobile
  config/profiles/*.json   Exact per-org profileDetails payloads (copied from mobile)
  utils/user-factory.ts    Provision a fresh user for an org (records to created-users.txt)
tests/
  smoke.spec.ts            Portal loads + login entry present
  login.spec.ts            Log in with an existing account
  helpers/login.ts         loginWithPassword() + T&C handling (real Ekshamata selectors)
  helpers/orgLoginSuite.ts orgLoginSuite('<KEY>') — provision + login + verify
  orgs/<KEY>.spec.ts       One thin spec per org (10 total)
```

## Adding an org

1. Add the org to `src/config/orgs.ts`.
2. Drop its `profileDetails` JSON in `src/config/profiles/<KEY>.json`.
3. Create `tests/orgs/<KEY>.spec.ts` containing `orgLoginSuite('<KEY>')`.

## Notes / TODO

- Selectors are ported from the working mobile WebView suite; if the localhost
  build differs from the packaged app, verify `button.lg-btn` /
  the "By Password" label against the running portal and adjust `helpers/login.ts`.
- The per-org suites depend on live Sphere provisioning creds; the plain
  `smoke`/`login` specs do not.
