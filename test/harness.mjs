// The one test seam (spec #21, "Testing Decisions"): run the real
// `shipment-tracker` entry point against a temp state dir, a fixed clock and
// fake transports, then look only at shipments.json, sources.json and events[].
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { main } from "../plugin/cli/main.mjs";

const FIXTURES = new URL("./fixtures/", import.meta.url);

export function fixture(path) {
  return JSON.parse(readFileSync(new URL(path, FIXTURES), "utf8"));
}

// A fake HTTP transport. `routes` maps a DHL tracking number (the `piececode`
// query parameter) to a recorded response: `{ json }`, `{ status, text }`,
// `{ network: true }` for a connection failure, or a function returning a
// Promise of one of those (to hold a request open).
export function fakeDhl(routes) {
  return {
    async fetch(url) {
      const u = new URL(url);
      if (u.host !== "www.dhl.de" || u.pathname !== "/int-verfolgen/data/search") {
        throw Object.assign(new Error(`unexpected request to ${u.host}${u.pathname}`), { code: "unexpected" });
      }
      const code = u.searchParams.get("piececode");
      let r = routes[code];
      if (typeof r === "function") r = await r();
      if (!r) throw Object.assign(new Error(`no recorded response for piececode ${code}`), { code: "unexpected" });
      if (r.network) throw Object.assign(new Error("fake network failure"), { code: "network" });
      return { status: r.status ?? 200, text: r.text ?? JSON.stringify(r.json) };
    },
  };
}

export async function makeWorld({ now = "2026-09-29T10:00:00.000Z", transport = fakeDhl({}), browser = fakeBrowser() } = {}) {
  const root = await mkdtemp(join(tmpdir(), "shipment-tracker-test-"));
  const env = {
    HOME: root, XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
  };
  const stateDir = join(env.XDG_STATE_HOME, "omarchy-shipment-tracker");
  const world = {
    now: new Date(now),
    transport,
    browser,
    env,
    stateDir,
    logs: [],
    output: [],
    setClock(iso) { world.now = new Date(iso); },
    async run(...argv) {
      return main(argv, {
        env,
        now: () => new Date(world.now),
        transport: world.transport,
        browser: world.browser,
        log: (line) => world.logs.push(line),
        out: (line) => world.output.push(line),
      });
    },
    async shipmentsFile() { return JSON.parse(await readFile(join(stateDir, "shipments.json"), "utf8")); },
    async sourcesFile() { return JSON.parse(await readFile(join(stateDir, "sources.json"), "utf8")); },
    async shipment(key) { return (await world.shipmentsFile()).shipments.find((s) => s.key === key); },
    async tokenFile() { return JSON.parse(await readFile(join(stateDir, "dhl-tokens.json"), "utf8")); },
    async tokenFileMode() { return (await stat(join(stateDir, "dhl-tokens.json"))).mode & 0o777; },
    async stateDirMode() { return (await stat(stateDir)).mode & 0o777; },
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
  return world;
}

// ---- The DHL Connection (spec #21, "Source adapters · DHL")

const DHL_TOKEN_URL = "https://login.dhl.de/af5f9bb6-27ad-4af4-9445-008e7a5cddb8/login/token";

// An unsigned JWT with synthetic claims; the CLI only reads its payload.
export function fakeIdToken(claims = { post_number: "0000000000" }) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.`;
}

// A fake DHL account behind the same transport: the token endpoint, the
// authenticated inbox and `piececode` enrichment (with the `dhli` cookie), and
// the anonymous lookup (no cookie) through `anonymous` routes as in fakeDhl.
//
// account.token(form) answers a token request (form: URLSearchParams); by
// default it issues a fresh refresh token each time and, like DHL, rejects any
// refresh token but the latest one with invalid_grant (rotation). account.inbox and
// account.enrich(ids) answer the two search calls with a recorded response.
// account.refreshTokens lists every refresh token the fake has seen used.
export function fakeDhlAccount({ inbox, enrich, anonymous = {}, claims } = {}) {
  let issued = 0;
  const anonymousFake = fakeDhl(anonymous);
  const account = {
    inbox,
    enrich,
    claims,
    refreshTokens: [],
    token(form) {
      if (form.get("grant_type") === "refresh_token") {
        account.refreshTokens.push(form.get("refresh_token"));
        if (form.get("refresh_token") !== `refresh-${issued}`) return { status: 400, json: { error: "invalid_grant" } };
      }
      issued++;
      return {
        json: {
          access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 1800,
          token_type: "Bearer", scope: "openid offline_access", id_token: fakeIdToken(account.claims),
        },
      };
    },
    async fetch(url, { method = "GET", headers = {}, body } = {}) {
      const u = new URL(url);
      if (u.origin + u.pathname === DHL_TOKEN_URL) {
        if (method !== "POST") throw Object.assign(new Error("token endpoint needs POST"), { code: "unexpected" });
        return answer(await account.token(new URLSearchParams(body)));
      }
      const cookie = headers.cookie ?? headers.Cookie;
      if (!cookie) return anonymousFake.fetch(url, { method, headers, body });
      if (!/^dhli=[^;]+$/.test(cookie)) throw Object.assign(new Error(`unexpected cookie ${cookie}`), { code: "unexpected" });
      const codes = u.searchParams.get("piececode");
      const r = codes === null ? account.inbox : typeof account.enrich === "function" ? account.enrich(codes.split(",")) : account.enrich;
      if (!r) throw Object.assign(new Error(`no recorded response for ${codes === null ? "the inbox" : "enrichment"}`), { code: "unexpected" });
      return answer(await r);
    },
  };
  return account;
}

function answer(r) {
  if (r.network) throw Object.assign(new Error("fake network failure"), { code: "network" });
  return { status: r.status ?? 200, text: r.text ?? JSON.stringify(r.json) };
}

// A fake Chrome for `login`: it records where the login profile lives and
// "logs in" by answering the authorize URL with the app redirect, carrying the
// authorize request's state. outcome: "success" | "cancelled" | "timed-out" | "browser".
export function fakeBrowser({ outcome = "success", code = "fake-code" } = {}) {
  const browser = {
    outcome,
    launches: [],
    async catchRedirect({ url, profileDir, redirectPrefix }) {
      browser.launches.push({ url, profileDir });
      if (browser.outcome !== "success") throw Object.assign(new Error(`fake ${browser.outcome}`), { code: browser.outcome });
      const state = new URL(url).searchParams.get("state");
      return `${redirectPrefix}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    },
  };
  return browser;
}
