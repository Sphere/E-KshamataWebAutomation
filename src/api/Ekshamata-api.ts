/**
 * Thin client for the three Sphere user-provisioning APIs used to onboard a
 * fresh Ekshamata user before a web-portal test run:
 *   1. createUser     POST /api/user/v3/create
 *   2. assignRole     POST /api/user/private/v1/assign/role
 *   3. updateProfile  PATCH /api/user/private/v1/update
 *
 * Ekshamata and Sphere share the same Sunbird-based user backend, so the SAME
 * provisioning APIs mint accounts that can log in to the Ekshamata web portal.
 *
 * Auth is the same for all three: a bearer token + connect.sid cookie, both
 * read from .env (SPHERE_API_TOKEN, SPHERE_API_COOKIE). These are session
 * creds and WILL expire — when calls start returning 401/419, refresh them
 * from Postman / browser DevTools and paste the new values into .env.
 */

/**
 * The provisioning backend FOLLOWS the environment under test.
 *
 * Ekshamata prod and sphere.aastrika.org share one backend; ekshamata-staging
 * and portal-staging share a different one (572 vs 525 live courses). Pinning
 * this to prod meant a staging run created the account on prod and then could
 * not log in on staging — the failure surfaced as a 30s waitForURL timeout.
 *
 * SPHERE_BASE_URL still overrides everything.
 */
function resolveBaseUrl(): string {
  if (process.env.SPHERE_BASE_URL) return process.env.SPHERE_BASE_URL.replace(/\/+$/, '');
  const target = process.env.BASE_URL || '';
  if (/staging/i.test(target)) return 'https://ekshamata-staging.aastrika.org';
  // UAT (ekshamata-uat / uat.aastrika.org) is a THIRD backend — never let it fall
  // through to production, or a UAT run would create its users on prod.
  if (/(^|\/\/|[.-])uat\./i.test(target)) return 'https://ekshamata-uat.aastrika.org';
  return 'https://sphere.aastrika.org';
}

export const BASE_URL = resolveBaseUrl();
export const IS_STAGING = /staging/i.test(BASE_URL);
export const IS_UAT = /ekshamata-uat|\/\/uat\./i.test(BASE_URL);

/**
 * Staging serves the profile update from the userorg service DIRECTLY — the
 * /api gateway does not expose /api/user/private/v1/update there (404), and the
 * public /api/user/v1/update wants the user's own session (401). Override with
 * STAGING_USERORG_UPDATE_URL if the load balancer address changes.
 */
export const STAGING_USERORG_UPDATE_URL =
  process.env.STAGING_USERORG_UPDATE_URL
  || 'http://a4686c843e49343fbb2439ab04e2f479-610586589.ap-south-1.elb.amazonaws.com/userorg/private/user/v1/update';

/**
 * UAT has the same gap as staging (no gateway route for the profile update), so
 * the update goes to UAT's userorg service directly. Address provided by the
 * platform team (2026-10-02); override with UAT_USERORG_UPDATE_URL if it moves.
 */
export const UAT_USERORG_UPDATE_URL =
  (process.env.UAT_USERORG_UPDATE_URL || '').trim()
  || 'http://a81873cf50b6e4247859561220f6e108-300940392.ap-south-1.elb.amazonaws.com/userorg/private/user/v1/update';

/**
 * Prod profile update goes to the userorg service directly: after the UAT→prod
 * migration that ELB now serves production, and the /api gateway routes answer
 * 401 (UNAUTHORIZED_USER) for the api_admin token. Override with
 * PROD_USERORG_UPDATE_URL if the address changes.
 */
export const PROD_USERORG_UPDATE_URL =
  (process.env.PROD_USERORG_UPDATE_URL || '').trim()
  || 'http://a81873cf50b6e4247859561220f6e108-300940392.ap-south-1.elb.amazonaws.com/userorg/private/user/v1/update';

export function authHeaders(): Record<string, string> {
  // Staging has its own api_admin token; fall back to the prod one if unset.
  // UAT has its own too, with NO fallback — a production token must never be
  // sent to (or silently accepted by) a different backend.
  const token = IS_UAT
    ? process.env.SPHERE_UAT_API_TOKEN
    : (IS_STAGING && process.env.SPHERE_STAGING_API_TOKEN) || process.env.SPHERE_API_TOKEN;
  const cookie = IS_UAT
    ? process.env.SPHERE_UAT_API_COOKIE
    : IS_STAGING
      ? process.env.SPHERE_STAGING_API_COOKIE
      : process.env.SPHERE_API_COOKIE;
  if (!token) {
    throw new Error(IS_UAT
      ? 'SPHERE_UAT_API_TOKEN not set in .env (UAT needs its own api_admin token)'
      : IS_STAGING
        ? 'SPHERE_STAGING_API_TOKEN (or SPHERE_API_TOKEN) not set in .env'
        : 'SPHERE_API_TOKEN not set in .env');
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // Token already includes the "bearer " style value? Normalize either way.
    Authorization: token.toLowerCase().startsWith('bearer ') ? token : `bearer ${token}`,
  };
  // The cookie is OPTIONAL: staging accepts the bearer alone. Only prod's
  // session-scoped calls need it, so send it when we have one.
  if (cookie) headers.Cookie = cookie.startsWith('connect.sid=') ? cookie : `connect.sid=${cookie}`;
  return headers;
}

async function call(method: string, path: string, body: unknown): Promise<any> {
  // The path may be an ABSOLUTE url — staging exposes the userorg service
  // directly rather than behind the /api gateway.
  const url = /^https?:\/\//i.test(path) ? path : `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    // The server's own reason goes on the FIRST line too: reports show only that
    // line, and a bare "403 Forbidden" can't tell a bad token from a blocked caller.
    const why = text.replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new Error(`${method} ${path} -> ${res.status} ${res.statusText}${why ? ` — ${why}` : ''}\n${text}`);
  }
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} returned non-JSON:\n${text}`);
  }
  // Sunbird envelope: params.status === 'SUCCESS' / responseCode === 'OK' (case varies).
  const status: string | undefined = json?.params?.status;
  const code: string | undefined = json?.responseCode;
  const ok = (status && /^success/i.test(status)) || (code && /^ok$/i.test(code));
  if (!ok) {
    throw new Error(`${method} ${path} not successful:\n${text}`);
  }
  return json;
}

/**
 * Reads the org's exact `channel` string (byte-for-byte) via org search.
 * Use this instead of hand-typing the channel — some orgs store invisible
 * characters (e.g. a non-breaking space) that create-user validates strictly.
 */
export async function getOrgChannel(orgId: string): Promise<string> {
  const json = await call('POST', '/api/org/v1/search', {
    request: { filters: { id: orgId } },
  });
  const channel: string | undefined = json?.result?.response?.content?.[0]?.channel;
  if (!channel) {
    throw new Error(`No channel found for org ${orgId}:\n${JSON.stringify(json)}`);
  }
  return channel;
}

export interface CreateUserInput {
  email: string;
  firstName: string;
  lastName: string;
  password: string;
  channel: string; // org name, e.g. "Bihar Nursing Registration Council"
  /** Org id — the form STAGING requires (it rejects every `channel` value). */
  organisationId?: string;
}

/**
 * Creates the user and returns the new userId.
 *
 * The two backends disagree on how the org is named:
 *   prod    — accepts `channel` (the org's display name)
 *   staging — rejects EVERY channel value (INVALID_PARAMETER_VALUE) and wants
 *             `organisationId` instead
 * So we send what the environment takes, and fall back automatically if the
 * backend disagrees — no per-environment branching at the call sites.
 */
export async function createUser(input: CreateUserInput): Promise<string> {
  const { organisationId, ...withChannel } = input;
  const byOrgId = { ...withChannel, organisationId } as Record<string, unknown>;
  delete (byOrgId as any).channel;

  const attempts: Record<string, unknown>[] = organisationId && IS_STAGING
    ? [byOrgId, withChannel]
    : organisationId ? [withChannel, byOrgId] : [withChannel];

  let lastError: unknown;
  let json: any;
  for (const request of attempts) {
    try {
      json = await call('POST', '/api/user/v3/create', { request });
      lastError = undefined;
      break;
    } catch (e: any) {
      lastError = e;
      // Only the channel/org disagreement is worth retrying differently.
      if (!/parameter channel|INVALID_PARAMETER_VALUE/i.test(String(e?.message ?? ''))) throw e;
      console.log('[api] create-user rejected the org form — retrying the other one');
    }
  }
  if (lastError) throw lastError;
  const userId: string | undefined = json?.result?.userId;
  if (!userId) {
    throw new Error(`createUser succeeded but no userId in response:\n${JSON.stringify(json)}`);
  }
  return userId;
}

/** Assigns roles (default PUBLIC) to the user within the given organisation. */
export async function assignRole(
  userId: string,
  organisationId: string,
  roles: string[] = ['PUBLIC'],
): Promise<void> {
  await call('POST', '/api/user/private/v1/assign/role', {
    request: { userId, organisationId, roles },
  });
}

/**
 * Updates the user's profile. `profileDetails` is the per-org JSON block;
 * the userId is injected into all the places the API expects it.
 */
export async function updateProfile(userId: string, profileDetails: any): Promise<void> {
  const details = structuredClone(profileDetails);
  if (details?.profileReq) {
    details.profileReq.id = userId;
    details.profileReq.userId = userId;
  }
  const body = { request: { userId, profileDetails: details } };

  // Where the profile update lives differs per environment:
  //   prod    — the userorg service directly (PROD_USERORG_UPDATE_URL): after the
  //             UAT→prod migration the gateway routes 401 for the api_admin token,
  //             so the direct userorg endpoint is tried first, gateway as fallback.
  //   staging — the userorg service directly (the gateway route is a 404 there,
  //             and the public /api/user/v1/update wants the user's own session)
  //   uat     — same as staging: the gateway route is a 404 and the public routes
  //             401 (even with the user's own token, checked 2026-10-01), so it
  //             goes to UAT's userorg service directly (UAT_USERORG_UPDATE_URL).
  const endpoints = IS_STAGING
    ? [STAGING_USERORG_UPDATE_URL, '/api/user/private/v1/update', '/api/user/v1/update']
    : IS_UAT
      ? [UAT_USERORG_UPDATE_URL, '/api/user/private/v1/update', '/api/user/v1/update']
      : [PROD_USERORG_UPDATE_URL, '/api/user/private/v1/update', '/api/user/v1/update'];

  let lastError: unknown;
  for (const endpoint of endpoints) {
    try {
      await call('PATCH', endpoint, body);
      if (endpoint !== endpoints[0]) console.log(`[api] profile updated via ${endpoint}`);
      return;
    } catch (e: any) {
      lastError = e;
      // Only fall through when the ROUTE is wrong/unauthorised; a genuine
      // rejection of our payload should surface, not be retried elsewhere.
      if (!/404|Not Found|401|Unauthorized/i.test(String(e?.message ?? ''))) throw e;
    }
  }

  console.log('[api] ⚠️  Profile details NOT applied — every update endpoint was rejected.');
  console.log(`      tried: ${endpoints.join(' , ')}`);
  console.log(`      last error: ${String((lastError as any)?.message ?? lastError).split('\n')[0].slice(0, 160)}`);
  throw lastError;
}
