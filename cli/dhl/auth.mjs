// DHL's app login (Akamai CIAM): the app's public OIDC client with PKCE, the
// `claims` parameter asking for `post_number`, and the `dhllogin://` redirect.
// Proven by ha-dhl and ioBroker.parcel, and live in the #7 spike
// (prototype/dhl-discovery, spikes/dhl/FINDINGS.md).
//
// The ID token lives 30 minutes, so every refresh renews it first. The refresh
// token rotates on every use: the new one is saved (atomically, mode 600)
// before anything else happens, under a lock so two runs never spend the same
// token.
import { createHash, randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { withLock } from "../lock.mjs";
import { ensureStateDir, writeAtomic } from "../state.mjs";

const OIDC_ROOT = "https://login.dhl.de/af5f9bb6-27ad-4af4-9445-008e7a5cddb8/login";
const AUTHORIZE_URL = `${OIDC_ROOT}/authorize`;
const TOKEN_URL = `${OIDC_ROOT}/token`;
const CLIENT_ID = "83471082-5c13-4fce-8dcb-19d2a3fca413";
export const REDIRECT_PREFIX = "dhllogin://de.deutschepost.dhl/login";
const SCOPE = "openid offline_access";
const CLAIMS = JSON.stringify({
  id_token: {
    email: null, post_number: null, twofa: null, service_mask: null, deactivate_account: null,
    last_login: null, customer_type: null, display_name: null, data_confirmation_required: null,
  },
});
const TOKEN_HEADERS = {
  accept: "application/json, text/plain, */*",
  "content-type": "application/x-www-form-urlencoded",
  origin: "https://login.dhl.de",
  "user-agent": "DHLPaket_PROD/1367 CFNetwork/1240.0.4 Darwin/20.6.0",
  "accept-language": "de-de",
  authorization: "Basic " + Buffer.from(`${CLIENT_ID}:`).toString("base64"),
};

const TOKEN_FILE = "dhl-tokens.json";
const TOKEN_LOCK = "dhl-tokens.json.lock";

const b64url = (bytes) => bytes.toString("base64url");

// A fresh authorize request: the URL to open and what the code exchange needs.
export function authorizeRequest() {
  const verifier = b64url(randomBytes(64));
  const state = b64url(randomBytes(24));
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_PREFIX,
    scope: SCOPE,
    claims: CLAIMS,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    state,
    nonce: b64url(randomBytes(24)),
    prompt: "login",
  });
  return { url: `${AUTHORIZE_URL}?${params}`, verifier, state };
}

// The `dhllogin://…` redirect → { code } or { error }.
export function readRedirect(redirectUrl, expectedState) {
  let u;
  try {
    u = new URL(redirectUrl);
  } catch {
    return { error: "the login redirect was unreadable" };
  }
  if (u.searchParams.get("state") !== expectedState) return { error: "the login redirect didn't match this login" };
  const code = u.searchParams.get("code");
  if (!code) return { error: `DHL refused the login (${u.searchParams.get("error") || "no code"})` };
  return { code };
}

// Exchanges the authorization code and saves the tokens.
// Returns { ok: true } or { ok: false, reason, message }.
export async function exchangeCode({ stateDir, transport, now }, { code, verifier }) {
  return withTokenLock(stateDir, async () => {
    const result = await postToken(transport, {
      redirect_uri: REDIRECT_PREFIX, grant_type: "authorization_code", code_verifier: verifier, code,
    });
    if (!result.ok) return result;
    if (!result.payload.refresh_token) return { ok: false, reason: "http", message: "DHL gave no refresh token" };
    if (!hasPostNumber(result.payload.id_token)) return { ok: false, reason: "account-link-lost", message: "DHL account has no post number" };
    await saveTokens(stateDir, result.payload, null, now());
    return { ok: true };
  });
}

// Renews the ID token with the stored refresh token, saving the rotated one
// first. Returns { ok: true, idToken } or { ok: false, reason } where reason is
// "not-set-up" (no token file), "expired" (refresh token rejected),
// "account-link-lost" (no post_number claim), "network", "http" or "shape".
export async function renewIdToken({ stateDir, transport, now }) {
  return withTokenLock(stateDir, async () => {
    const stored = await loadTokens(stateDir);
    if (!stored?.refresh_token) return { ok: false, reason: "not-set-up" };
    const result = await postToken(transport, {
      redirect_uri: REDIRECT_PREFIX, grant_type: "refresh_token", refresh_token: stored.refresh_token,
    });
    if (!result.ok) return result;
    await saveTokens(stateDir, result.payload, stored, now());
    if (!hasPostNumber(result.payload.id_token)) return { ok: false, reason: "account-link-lost" };
    return { ok: true, idToken: result.payload.id_token };
  });
}

export async function hasTokens(stateDir) {
  return Boolean((await loadTokens(stateDir))?.refresh_token);
}

// `disconnect dhl`: deletes the token file under the token lock, so a refresh
// renewing the token right now finishes first and the next one finds none;
// then the lock file itself.
export async function forgetTokens(stateDir) {
  await withTokenLock(stateDir, () => rm(join(stateDir, TOKEN_FILE), { force: true }));
  await rm(join(stateDir, TOKEN_LOCK), { force: true });
}

async function postToken(transport, form) {
  let response;
  try {
    response = await transport.fetch(TOKEN_URL, { method: "POST", headers: TOKEN_HEADERS, body: new URLSearchParams(form).toString() });
  } catch (e) {
    if (e.code === "network") return { ok: false, reason: "network" };
    throw e;
  }
  let payload = null;
  try {
    payload = JSON.parse(response.text);
  } catch {}
  if (response.status >= 200 && response.status < 300) {
    return payload?.id_token ? { ok: true, payload } : { ok: false, reason: "shape" };
  }
  if ((response.status === 400 || response.status === 401) && payload?.error === "invalid_grant") {
    return { ok: false, reason: "expired" };
  }
  return { ok: false, reason: "http" };
}

function claimsOf(idToken) {
  try {
    return JSON.parse(Buffer.from(String(idToken).split(".")[1], "base64url").toString());
  } catch {
    return null;
  }
}

const hasPostNumber = (idToken) => Boolean(claimsOf(idToken)?.post_number);

async function loadTokens(stateDir) {
  try {
    return JSON.parse(await readFile(join(stateDir, TOKEN_FILE), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

async function saveTokens(stateDir, payload, previous, at) {
  await writeAtomic(join(stateDir, TOKEN_FILE), {
    refresh_token: payload.refresh_token || previous?.refresh_token,
    id_token: payload.id_token,
    id_token_expires_at: new Date(at.getTime() + (Number(payload.expires_in) || 1800) * 1000).toISOString(),
    first_login_at: previous?.first_login_at || at.toISOString(),
    last_refresh_at: at.toISOString(),
  }, 0o600);
}

async function withTokenLock(stateDir, fn) {
  await ensureStateDir(stateDir);
  return withLock(join(stateDir, TOKEN_LOCK), fn);
}
