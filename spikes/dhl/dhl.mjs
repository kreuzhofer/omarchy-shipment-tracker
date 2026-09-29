#!/usr/bin/env node
// Throwaway spike for "DHL discovery spike" (#7). Not production code.
//
// Reads the dhl.de Sendungsliste (account inbox) over plain HTTP with a stored
// refresh token, following ha-dhl's proven auth constants (see
// docs/research/dhl-sendungsliste.md on branch research/dhl-sendungsliste).
//
//   node dhl.mjs login            one-time login in a dedicated Chrome profile;
//                                 the dhllogin:// redirect is caught over CDP
//   node dhl.mjs list             fetch the inbox, print a summary, dump raw JSON
//   node dhl.mjs lookup <code>..  anonymous by-number lookup (manual add path)
//   node dhl.mjs probe            refresh + list, append one line to probe.log
//
// Secrets and raw responses live in ~/.local/state/omarchy-shipment-tracker/,
// never in the repo.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const STATE = join(homedir(), ".local/state/omarchy-shipment-tracker/spike-dhl");
const TOKENS = join(STATE, "tokens.json");
const PROBE_LOG = join(STATE, "probe.log");
const PROFILE = join(STATE, "chrome-profile");
mkdirSync(STATE, { recursive: true, mode: 0o700 });

const OIDC_ROOT = "https://login.dhl.de/af5f9bb6-27ad-4af4-9445-008e7a5cddb8/login";
const CLIENT_ID = "83471082-5c13-4fce-8dcb-19d2a3fca413";
const REDIRECT_URI = "dhllogin://de.deutschepost.dhl/login";
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
const SEARCH_URL = "https://www.dhl.de/int-verfolgen/data/search";
const SEARCH_HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
  "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  "accept-language": "de-de",
};
const TIMEOUT = 30_000;

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const now = () => new Date().toISOString();

function claimsOf(idToken) {
  try {
    return JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString());
  } catch {
    return null;
  }
}

async function discover() {
  const r = await fetch(`${OIDC_ROOT}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`discovery HTTP ${r.status}`);
  return r.json();
}

async function postToken(tokenEndpoint, body) {
  const r = await fetch(tokenEndpoint, {
    method: "POST",
    headers: TOKEN_HEADERS,
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await r.text();
  let payload = {};
  try { payload = JSON.parse(text); } catch {}
  if (r.ok && payload.id_token) return payload;
  throw new Error(`token endpoint HTTP ${r.status}: ${payload.error || text.slice(0, 200)}`);
}

function saveTokens(payload, previous = {}) {
  const claims = claimsOf(payload.id_token) || {};
  const data = {
    refresh_token: payload.refresh_token || previous.refresh_token,
    id_token: payload.id_token,
    id_token_expires_at: new Date(Date.now() + (Number(payload.expires_in) || 1800) * 1000).toISOString(),
    first_login_at: previous.first_login_at || now(),
    last_refresh_at: now(),
    refresh_token_rotated: Boolean(payload.refresh_token && previous.refresh_token && payload.refresh_token !== previous.refresh_token),
    has_post_number: Boolean(claims.post_number),
  };
  writeFileSync(TOKENS, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(TOKENS, 0o600);
  return data;
}

function loadTokens() {
  if (!existsSync(TOKENS)) throw new Error("not logged in: run `node dhl.mjs login` first");
  return JSON.parse(readFileSync(TOKENS, "utf8"));
}

// ---- login: dedicated Chrome profile + CDP to catch the dhllogin:// redirect

async function cdpConnect(port) {
  for (let i = 0; i < 50; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      return v.webSocketDebuggerUrl;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("Chrome DevTools endpoint did not come up");
}

function captureRedirect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const send = (method, params = {}, sessionId) =>
      ws.send(JSON.stringify({ id: ++id, method, params, ...(sessionId ? { sessionId } : {}) }));
    const pattern = /dhllogin:\/\/de\.deutschepost\.dhl\/login\?[^"'\s\\]+/;
    ws.onopen = () => {
      send("Target.setDiscoverTargets", { discover: true });
      send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      send("Target.getTargets");
    };
    ws.onerror = (e) => reject(new Error("CDP websocket error " + (e.message || "")));
    ws.onmessage = (msg) => {
      const text = String(msg.data);
      const hit = text.match(pattern);
      if (hit) {
        ws.close();
        resolve({ url: hit[0].replace(/\\u0026/g, "&"), via: JSON.parse(text).method || "response" });
        return;
      }
      const m = JSON.parse(text);
      if (m.method === "Target.attachedToTarget") {
        const sid = m.params.sessionId;
        send("Network.enable", {}, sid);
        send("Page.enable", {}, sid);
        send("Runtime.runIfWaitingForDebugger", {}, sid);
      } else if (m.result?.targetInfos) {
        for (const t of m.result.targetInfos) {
          if (t.type === "page") send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
        }
      }
    };
  });
}

async function login() {
  const endpoints = await discover();
  const verifier = b64url(randomBytes(64));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(24));
  const params = new URLSearchParams({
    response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: SCOPE, claims: CLAIMS,
    code_challenge: challenge, code_challenge_method: "S256", state, nonce: b64url(randomBytes(24)), prompt: "login",
  });
  const authUrl = `${endpoints.authorization_endpoint}?${params}`;
  const port = 9333;
  const chrome = spawn("google-chrome-stable", [
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${port}`, "--no-first-run",
    "--no-default-browser-check", "--password-store=gnome-libsecret", "--new-window", authUrl,
  ], { stdio: "ignore", detached: true });
  chrome.unref();
  console.log("A Chrome window opened on the DHL login. Log in there (2FA if asked); it closes on success.");

  let redirect;
  const fromCdp = captureRedirect(await cdpConnect(port)).then((r) => ({ ...r, source: "cdp" }));
  const fromPaste = (async () => {
    if (!process.stdin.isTTY) return new Promise(() => {});
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("(fallback) or paste the dhllogin:// URL here: ");
    rl.close();
    return { url: answer.trim(), source: "paste" };
  })();
  redirect = await Promise.race([fromCdp, fromPaste]);
  try { process.kill(-chrome.pid); } catch { try { chrome.kill(); } catch {} }

  const u = new URL(redirect.url);
  if (u.searchParams.get("state") !== state) throw new Error("state mismatch; aborting");
  const code = u.searchParams.get("code");
  if (!code) throw new Error("redirect had no code: " + redirect.url.slice(0, 80));
  const payload = await postToken(endpoints.token_endpoint, {
    redirect_uri: REDIRECT_URI, grant_type: "authorization_code", code_verifier: verifier, code,
  });
  if (!payload.refresh_token) throw new Error("no refresh_token: offline_access not granted");
  const saved = saveTokens(payload);
  console.log(`Logged in (redirect caught via ${redirect.source}${redirect.via ? "/" + redirect.via : ""}). post_number claim: ${saved.has_post_number}`);
  console.log("Token response fields:", Object.keys(payload).join(", "), "| expires_in:", payload.expires_in);
}

// ---- tokens

async function validIdToken({ force = false } = {}) {
  const t = loadTokens();
  if (!force && Date.now() < new Date(t.id_token_expires_at).getTime() - 300_000) return t;
  const { token_endpoint } = await discover();
  const payload = await postToken(token_endpoint, {
    redirect_uri: REDIRECT_URI, grant_type: "refresh_token", refresh_token: t.refresh_token,
  });
  return saveTokens(payload, t);
}

// ---- search endpoint

async function search({ idToken, piececodes } = {}) {
  const params = new URLSearchParams({ noRedirect: "true", language: "de", cid: "app" });
  if (piececodes?.length) params.set("piececode", piececodes.join(","));
  const headers = { ...SEARCH_HEADERS };
  if (idToken) headers.cookie = `dhli=${idToken}`;
  const r = await fetch(`${SEARCH_URL}?${params}`, { headers, signal: AbortSignal.timeout(TIMEOUT) });
  const text = await r.text();
  if (!r.ok) throw new Error(`search HTTP ${r.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const DIRECTION = { ANKOMMEND: "Incoming", EINGEHEND: "Incoming", ABGEHEND: "Outgoing", AUSGEHEND: "Outgoing" };

function summarize(s) {
  const info = s.sendungsinfo || {};
  const det = s.sendungsdetails || {};
  const verlauf = det.sendungsverlauf || {};
  const z = det.zustellung || {};
  return {
    id: s.id,
    direction: DIRECTION[info.sendungsrichtung] || `?${info.sendungsrichtung}`,
    list: info.sendungsliste,
    name: info.sendungsname,
    progress: `${verlauf.fortschritt ?? "?"}/${verlauf.maximalFortschritt ?? "?"}`,
    kurzStatus: verlauf.kurzStatus,
    status: (verlauf.status || "").replace(/<[^>]+>/g, "").slice(0, 90),
    statusDate: verlauf.datumAktuellerStatus,
    delivered: det.istZugestellt,
    returned: Boolean(det.retoure || det.ruecksendung),
    window: z.zustellzeitfensterVon ? `${z.zustellzeitfensterVon}..${z.zustellzeitfensterBis}` : (z.zustellzeitfenster || z.zustelldatum || null),
    packstation: z.packageStationType || null,
    pickupCode: z.abholcodeAvailable ?? null,
    events: (verlauf.events || []).length,
  };
}

async function list() {
  const t = await validIdToken();
  const data = await search({ idToken: t.id_token });
  // Archived and some current elements arrive as stubs. An authenticated
  // by-number call answers with the whole inbox again, complete only for the
  // codes asked for, so asking for every id yields the full list in one call.
  const stubs = (data.sendungen || []).filter((s) => !s.hasCompleteDetails);
  if (stubs.length && !process.argv.includes("--no-enrich")) {
    const full = await search({ idToken: t.id_token, piececodes: data.sendungen.map((s) => s.id) });
    const stillStubs = (full.sendungen || []).filter((s) => !s.hasCompleteDetails).length;
    if (stillStubs) console.log(`warning: ${stillStubs} elements still incomplete after enrichment`);
    data.sendungen = full.sendungen;
  }
  const stamp = now().replace(/[:.]/g, "-");
  const dump = join(STATE, `inbox-${stamp}.json`);
  writeFileSync(dump, JSON.stringify(data, null, 2), { mode: 0o600 });
  const rows = (data.sendungen || []).map(summarize);
  console.log(`rateLimited=${data.rateLimited} shipments=${rows.length} post_number=${t.has_post_number} raw=${dump}`);
  console.table(rows);
  return { data, rows, t };
}

async function lookup(codes) {
  const data = await search({ piececodes: codes });
  writeFileSync(join(STATE, `lookup-${now().replace(/[:.]/g, "-")}.json`), JSON.stringify(data, null, 2), { mode: 0o600 });
  console.table((data.sendungen || []).map(summarize));
}

async function probe() {
  const line = { at: now() };
  try {
    const before = loadTokens();
    line.hours_since_login = +((Date.now() - new Date(before.first_login_at)) / 3.6e6).toFixed(2);
    const t = await validIdToken({ force: true });
    line.refresh = "ok";
    line.rotated = t.refresh_token_rotated;
    line.post_number = t.has_post_number;
    const inbox = await search({ idToken: t.id_token });
    const ids = (inbox.sendungen || []).map((s) => s.id);
    const data = ids.length ? await search({ idToken: t.id_token, piececodes: ids }) : inbox;
    const all = data.sendungen || [];
    line.shipments = all.length;
    line.incomplete = all.filter((s) => !s.hasCompleteDetails).length;
    line.outgoing = all.filter((s) => DIRECTION[s.sendungsinfo?.sendungsrichtung] === "Outgoing").length;
    line.rateLimited = data.rateLimited;
    // Keep raw evidence for the open questions: Outgoing progress ladder,
    // Filiale / Packstation pickup, and returns.
    const interesting = all.filter((s) => {
      const d = s.sendungsdetails || {};
      const z = d.zustellung || {};
      return DIRECTION[s.sendungsinfo?.sendungsrichtung] === "Outgoing" || z.benachrichtigtInFiliale ||
        z.abholcodeAvailable || z.packageStationType || d.retoure || d.ruecksendung;
    });
    if (interesting.length) {
      line.evidence = interesting.map((s) => s.id);
      writeFileSync(join(STATE, `evidence-${now().replace(/[:.]/g, "-")}.json`), JSON.stringify(interesting, null, 2), { mode: 0o600 });
    }
  } catch (e) {
    line.error = String(e.message || e).slice(0, 200);
  }
  appendFileSync(PROBE_LOG, JSON.stringify(line) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(line));
}

const [cmd, ...args] = process.argv.slice(2);
const commands = { login, list, lookup: () => lookup(args), probe };
if (!commands[cmd]) {
  console.error("usage: node dhl.mjs login | list | lookup <piececode...> | probe");
  process.exit(2);
}
commands[cmd]().catch((e) => {
  console.error("error:", e.message || e);
  process.exit(1);
});
