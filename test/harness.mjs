// The one test seam (spec #21, "Testing Decisions"): run the real
// `shipment-tracker` entry point against a temp state dir, a fixed clock and
// fake transports, then look only at shipments.json, sources.json and events[].
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
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

// The CDP methods the Amazon route may use. Anything else (Runtime.enable,
// Page.addScriptToEvaluateOnNewDocument, Emulation.*, …) fails the test.
const CDP_ALLOWED = new Set([
  "Target.getTargets", "Target.createTarget", "Target.attachToTarget", "Page.enable", "Page.navigate",
  "Target.getTargetInfo", "DOM.getDocument", "DOM.getOuterHTML", "Browser.close",
]);

// A fake Chrome for the Amazon route, spoken to over raw CDP like the real
// one. `routes` answers navigations:
//   history: the order history URL (/gp/css/order-history)
//   trackers: { "<orderId>#<packageIndex>": page } for /progress-tracker/package
// A page is an HTML string, { url, html } for a redirect, { error } for a
// network error, or a function ({ polls }) => page that is re-evaluated on
// every read (polls = reads since the navigation), e.g. for a user signing in.
// `{ closed: true }` means the user closed the window.
//   search: { "<orderId>": page } for the order search (/your-orders/search?search=…)
// Several accounts: `{ accounts: { <label>: routes } }`, picked by the
// profile directory Chrome is launched with.
// Options: launchFails (Chrome doesn't come up), busy (port already in use).
// Records launches, CDP methods, navigations (with the account's label) and
// reads with the world clock, and `overlapped` when two Chromes were up at once.
export function fakeChrome(allRoutes = {}, { launchFails = false, busy = false } = {}) {
  const fake = {
    clock: () => new Date(0),
    launches: [],
    methods: [],
    navigations: [],
    reads: [],
    hidden: false,
    open: false,
    overlapped: false,
    async launch({ args, port, hidden }) {
      fake.launches.push({ args, port, hidden });
      if (busy) throw Object.assign(new Error("port in use"), { code: "busy" });
      if (launchFails) throw Object.assign(new Error("no DevTools"), { code: "browser" });
      const label = args.find((a) => a.startsWith("--user-data-dir=")).split("/").at(-1);
      const routes = allRoutes.accounts ? allRoutes.accounts[label] : allRoutes;
      if (!routes) throw Object.assign(new Error(`no routes for account ${label}`), { code: "unexpected" });
      if (fake.open) fake.overlapped = true;
      fake.open = true;
      fake.hidden = hidden;
      const listeners = new Set();
      let route = () => ({ url: "about:blank", html: "<html></html>" });
      let polls = 0;
      let markClosed;
      const closed = new Promise((resolve) => { markClosed = resolve; });
      const current = () => {
        let page = route({ polls });
        if (typeof page === "function") page = page({ polls });
        if (page?.closed) {
          fake.open = false;
          markClosed();
          throw Object.assign(new Error("Chrome went away"), { code: "browser" });
        }
        return page;
      };
      const resolve = (url) => {
        const u = new URL(url);
        let page;
        if (u.pathname.startsWith("/gp/css/order-history")) page = routes.history;
        else if (u.pathname === "/progress-tracker/package") page = routes.trackers?.[`${u.searchParams.get("orderId")}#${u.searchParams.get("packageIndex")}`];
        else if (u.pathname.startsWith("/your-orders/search")) page = routes.search?.[u.searchParams.get("search")];
        if (page === undefined) throw Object.assign(new Error(`unexpected navigation to ${u.pathname}`), { code: "unexpected" });
        return (ctx) => {
          const p = typeof page === "function" ? page(ctx) : page;
          if (typeof p === "string") return { url, html: p };
          return p?.error || p?.closed ? p : { url: p.url ?? url, html: p.html };
        };
      };
      return {
        closed,
        async send(method, params = {}, sessionId) {
          fake.methods.push(method);
          if (!CDP_ALLOWED.has(method)) throw Object.assign(new Error(`forbidden CDP method ${method}`), { code: "unexpected" });
          if (!fake.open) throw Object.assign(new Error("Chrome went away"), { code: "browser" });
          switch (method) {
            case "Target.getTargets": return { targetInfos: [{ targetId: "T1", type: "page", url: "about:blank" }] };
            case "Target.attachToTarget": return { sessionId: "S1" };
            case "Page.enable": return {};
            case "Page.navigate": {
              fake.navigations.push({ url: params.url, at: fake.clock().getTime(), account: label });
              route = resolve(params.url);
              polls = 0;
              const page = route({ polls });
              if (page.error) {
                route = () => ({ url: "chrome-error://chromewebdata/", html: "<html></html>" });
                return { frameId: "F1", errorText: page.error };
              }
              setImmediate(() => { for (const l of listeners) l({ method: "Page.loadEventFired", sessionId, params: {} }); });
              return { frameId: "F1" };
            }
            case "Target.getTargetInfo": {
              const page = current();
              polls++;
              return { targetInfo: { targetId: "T1", type: "page", url: page.url } };
            }
            case "DOM.getDocument": return { root: { nodeId: 1 } };
            case "DOM.getOuterHTML": {
              const page = current();
              fake.reads.push({ url: page.url, at: fake.clock().getTime() });
              return { outerHTML: page.html };
            }
            case "Browser.close": fake.open = false; markClosed(); return {};
          }
          return {};
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async hide() { fake.hidden = true; },
        async close() { if (fake.open) await this.send("Browser.close"); },
      };
    },
  };
  return fake;
}

export async function makeWorld({ now = "2026-09-29T10:00:00.000Z", transport = fakeDhl({}), browser = fakeBrowser(), chrome = fakeChrome(), mail = fakeMail() } = {}) {
  const root = await mkdtemp(join(tmpdir(), "shipment-tracker-test-"));
  const env = {
    HOME: root,
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    TZ: "Europe/Berlin",
  };
  const stateDir = join(env.XDG_STATE_HOME, "omarchy-shipment-tracker");
  const world = {
    now: new Date(now),
    transport,
    browser,
    chrome,
    mail,
    env,
    stateDir,
    dataDir: join(env.XDG_DATA_HOME, "omarchy-shipment-tracker"),
    sleeps: [],
    logs: [],
    output: [],
    // systemd user units that `systemctl --user is-active` reports running.
    activeUnits: new Set(),
    cancelListeners: new Set(),
    // What Cancel (the unit's SIGTERM) or Ctrl-C does to a running Login.
    cancel() { for (const fn of world.cancelListeners) fn(); },
    setClock(iso) { world.now = new Date(iso); },
    async run(...argv) {
      return main(argv, {
        env,
        now: () => new Date(world.now),
        transport: world.transport,
        browser: world.browser,
        chrome: world.chrome,
        mcp: world.mail,
        // Pacing waits advance the fixed clock instead of sleeping.
        sleep: async (ms) => { world.sleeps.push(ms); world.now = new Date(world.now.getTime() + ms); },
        log: (line) => world.logs.push(line),
        out: (line) => world.output.push(line),
        exec: async (file, args) => {
          if (file === "systemctl" && args[0] === "--user" && args[1] === "is-active") return { code: world.activeUnits.has(args.at(-1)) ? 0 : 3, stdout: "", stderr: "" };
          throw Object.assign(new Error(`unexpected command ${file} ${args.join(" ")}`), { code: "unexpected" });
        },
        onCancel: (fn) => {
          world.cancelListeners.add(fn);
          return () => world.cancelListeners.delete(fn);
        },
      });
    },
    async shipmentsFile() { return JSON.parse(await readFile(join(stateDir, "shipments.json"), "utf8")); },
    async sourcesFile() { return JSON.parse(await readFile(join(stateDir, "sources.json"), "utf8")); },
    async shipment(key) { return (await world.shipmentsFile()).shipments.find((s) => s.key === key); },
    async tokenFile() { return JSON.parse(await readFile(join(stateDir, "dhl-tokens.json"), "utf8")); },
    async tokenFileMode() { return (await stat(join(stateDir, "dhl-tokens.json"))).mode & 0o777; },
    async stateDirMode() { return (await stat(stateDir)).mode & 0o777; },
    async exists(path) { return stat(path).then(() => true, () => false); },
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
  chrome.clock = () => world.now;
  mail.clock = () => world.now;
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
// authorize request's state. outcome: "success" | "cancelled" | "timed-out" | "browser",
// or "open": the window stays open until the Login is cancelled (its signal)
// or the test calls finish(outcome). `opened` resolves once a window is open;
// `timeoutMs` records the deadline it was given.
export function fakeBrowser({ outcome = "success", code = "fake-code" } = {}) {
  let markOpened;
  const browser = {
    outcome,
    launches: [],
    opened: new Promise((resolve) => { markOpened = resolve; }),
    finish: () => {},
    async catchRedirect({ url, profileDir, redirectPrefix, timeoutMs, signal }) {
      browser.launches.push({ url, profileDir, timeoutMs });
      if (browser.outcome === "open") {
        browser.outcome = await new Promise((resolve) => {
          browser.finish = resolve;
          signal?.addEventListener("abort", () => resolve("cancelled"), { once: true });
          markOpened();
        });
      }
      if (browser.outcome !== "success") throw Object.assign(new Error(`fake ${browser.outcome}`), { code: browser.outcome });
      const state = new URL(url).searchParams.get("state");
      return `${redirectPrefix}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    },
  };
  return browser;
}

// Holds an exclusive flock on `path` (a file or directory) from another
// process, like a second CLI run would. Returns release().
export async function holdLock(path) {
  await mkdir(path, { recursive: true });
  const holder = spawn("flock", ["--exclusive", path, "-c", "echo locked; exec cat >/dev/null"], { stdio: ["pipe", "pipe", "ignore"] });
  const exited = new Promise((resolve) => holder.once("close", resolve));
  await new Promise((resolve) => holder.stdout.once("data", resolve));
  return async () => { holder.stdin.end(); await exited; };
}

// ---- Microsoft 365 mail (spec #21, "Source adapters · Microsoft 365 mail")

// An MCP tool answer as Softeria sends it: JSON text content.
export const toolAnswer = (value, { isError = false } = {}) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

// A fake Softeria ms-365-mcp-server behind the MCP transport. `tools` maps a
// tool name to a recorded answer or a function (args, server) => answer,
// where server = { env, fake } (env: the MS365_MCP_* variables it was started
// with). A tool without an answer fails the test. Options: startFails
// ("server" | "network": the server can't be installed or started).
// Records starts ({ args, env, install }), calls ({ name, arguments, at })
// with the world clock, and how many servers are still open.
export function fakeMail(tools = {}, { startFails = null } = {}) {
  const fake = {
    clock: () => new Date(0),
    tools,
    starts: [],
    calls: [],
    open: 0,
    async start({ args, env, install }) {
      fake.starts.push({ args, env, install });
      if (startFails) throw Object.assign(new Error("fake server failure"), { code: startFails });
      fake.open++;
      let closed = false;
      return {
        async request(method, params) {
          if (closed) throw Object.assign(new Error("server closed"), { code: "server" });
          if (method === "initialize") return { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "Microsoft365MCP", version: "0.156.2" } };
          if (method !== "tools/call") throw Object.assign(new Error(`unexpected MCP method ${method}`), { code: "unexpected" });
          fake.calls.push({ name: params.name, arguments: params.arguments, at: fake.clock().toISOString() });
          let answer = fake.tools[params.name];
          if (typeof answer === "function") answer = await answer(params.arguments, { env, fake });
          if (!answer) throw Object.assign(new Error(`no recorded answer for tool ${params.name}`), { code: "unexpected" });
          if (answer.dies) throw Object.assign(new Error("the mail server exited"), { code: "server" });
          return answer;
        },
        notify() {},
        async close() {
          if (!closed) fake.open--;
          closed = true;
        },
      };
    },
  };
  return fake;
}
