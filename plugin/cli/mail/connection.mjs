// The `mail` Connection: the user's Microsoft 365 mailbox, an optional,
// best-effort input to the Amazon Source (spec #21, "Microsoft 365 mail").
//
// Per run: one search for amazon.de mail, the 30-day window applied here
// ($search can't be combined with $filter). Each Order a mail names becomes
// an Order-level Shipment `amazon:<orderId>` (account unknown, no Carrier),
// unless an Amazon account's history already shows that Order: then the
// browser route's package Shipments stand for it. Once an account's history
// shows an Order that mail found first, its Order-level Shipment merges into
// the package Shipments (absorbMailOrders, called by the Amazon run).
//
// A mailbox that can't be read only changes this Connection's Health; it
// never stops the other Sources. Health follows health.mjs: Softeria finding
// no account or failing its silent token refresh is `expired` (needs-login,
// retried every run); a network failure counts only when something else in
// the run got through (offline is not an error).
import { markKnown, recordEvents } from "../events.mjs";
import { clearUpdatedDismissals } from "../dismiss.mjs";
import { recordConnectionEvents, recordFailure, recordOk } from "../health.mjs";
import { runLogin } from "../logins.mjs";
import { orderDetailsUrl } from "../amazon/pages.mjs";
import { droppedKeys } from "../retention.mjs";
import { applyReading, TERMINAL } from "../shipments.mjs";
import { readState, updateState } from "../state.mjs";
import { lastAuthDetail, openServer, removeFiles, tightenFiles } from "./mcp.mjs";
import { readMails } from "./status.mjs";

export const KEY = "mail";
const WINDOW_DAYS = 30;
const SEARCH = { search: '"from:amazon.de"', select: ["id", "receivedDateTime", "from", "subject", "body"], top: 100 };
const POLL_MS = 5000;

// Why a tool call failed, from its answer (and, for a failed silent token
// refresh, what Softeria logged about it), as data: the first row that
// matches wins; anything else is `http`.
const FAILURES = [
  { reason: "network", when: /fetch failed|network|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timed out/i },
  { reason: "expired", when: /No valid token|No accounts found|login first|Silent token acquisition failed|InvalidAuthenticationToken|API error: 401/i },
  { reason: "rate-limited", when: /API error: 429/i },
];
const failure = (text) => FAILURES.find((f) => f.when.test(text))?.reason ?? "http";

const MESSAGES = {
  shape: "Microsoft 365 mail changed its data format · an update of the tracker is needed",
  server: "Microsoft 365 mail can't be read: the mail server didn't start",
};

const isOrderLevel = (s, orderId) => s.source === "Amazon" && s.key === `amazon:${orderId}`;
const packagesOf = (list, orderId) => list.filter((s) => s.source === "Amazon" && s.orderId === orderId && !isOrderLevel(s, orderId));

// Reads the mailbox: { ok: true, readings, ignored } or { ok: false, reason }.
async function readMailbox({ stateDir, mcp, now, timeZone }) {
  let server;
  try {
    server = await openServer(mcp, stateDir);
  } catch (e) {
    if (e.code === "network") return { ok: false, reason: "network" };
    if (e.code === "server") return { ok: false, reason: "server" };
    throw e;
  }
  let answer;
  try {
    answer = await server.tool("list-mail-messages", SEARCH);
  } catch (e) {
    if (e.code !== "server") throw e;
    return { ok: false, reason: "server" };
  } finally {
    await server.close().catch(() => {});
  }
  if (answer.isError) {
    const detail = /Silent token acquisition failed/.test(answer.text) ? await lastAuthDetail(stateDir) : "";
    return { ok: false, reason: failure(`${detail} ${answer.text}`) };
  }
  const messages = answer.json?.value;
  if (!Array.isArray(messages)) return { ok: false, reason: "shape" };
  const since = new Date(now().getTime() - WINDOW_DAYS * 864e5);
  return { ok: true, ...readMails(messages, since, timeZone) };
}

// Part of `refresh`, between DHL and Amazon. Not read: not set up, or a Login
// of it is running (except the Login's own first sync).
export async function refreshMail({ stateDir, mcp, now, timeZone, log, counts, finishRun, firstSync = false }) {
  const conn = (await readState(stateDir)).sources.connections?.[KEY];
  if (!mcp || !conn) return;
  if (!firstSync && (conn.health === "not-set-up" || conn.login)) return;
  const outcome = await readMailbox({ stateDir, mcp, now, timeZone });
  if (outcome.ok) counts.synced++;
  else {
    counts.failed++;
    if (outcome.reason === "network") counts.network++;
  }
  // Offline is not an error: a network failure counts once something else
  // in the run got through (else refresh.mjs counts it at the end, if so).
  const countNetwork = firstSync || counts.lookedUp > 0 || counts.synced > 0;
  await updateState(stateDir, ({ shipments, sources }) => {
    const c = sources.connections?.[KEY];
    const at = now();
    // Disconnected while the run was in flight.
    if (!c || (c.health === "not-set-up" && !firstSync)) return;
    if (firstSync) markKnown(shipments);
    // A Login that got through has proven the mailbox, even if its first
    // sync then fails.
    if (firstSync && c.health !== "ok") {
      Object.assign(c, { health: "ok", reason: null, message: null, since: at.toISOString() });
    }
    if (!outcome.ok) {
      recordFailure(c, at, outcome.reason, { message: MESSAGES[outcome.reason] ?? null, countNetwork });
    } else {
      applyReadings(shipments, outcome.readings, at);
      recordOk(c, at, shipments.shipments.filter((s) => s.connections.includes(KEY)).length);
    }
    finishRun(sources, at);
    if (firstSync) {
      clearUpdatedDismissals(shipments);
      recordEvents(shipments, { firstSync: new Set([KEY]) });
      recordConnectionEvents(shipments, sources);
    }
  });
  log(outcome.ok
    ? `refresh: mail ok, ${outcome.readings.length} Order(s)${outcome.ignored ? `, ${outcome.ignored} mail(s) ignored` : ""}`
    : `refresh: mail failed (${outcome.reason})`);
  return { ...outcome, counted: countNetwork };
}

function applyReadings(shipments, readings, now) {
  const list = shipments.shipments;
  const dropped = droppedKeys(shipments);
  const at = now.toISOString();
  for (const reading of readings) {
    const key = `amazon:${reading.orderId}`;
    if (dropped.has(key) || [...dropped].some((d) => d.startsWith(`${key}#`))) continue;
    // The browser route already reads this Order's Shipments.
    if (packagesOf(list, reading.orderId).length > 0) continue;
    let s = list.find((x) => x.key === key);
    if (!s) {
      s = {
        key,
        direction: "Incoming",
        source: "Amazon",
        account: null,
        carrier: null,
        connections: [],
        title: reading.title || reading.orderId,
        status: "Unknown",
        estimate: null,
        delayed: false,
        orderId: reading.orderId,
        url: orderDetailsUrl(reading.orderId),
        changedAt: at,
        discoveredAt: at,
        lastSeenAt: null,
      };
      list.push(s);
    }
    if (!s.connections.includes(KEY)) s.connections.push(KEY);
    // Terminal Shipments never change again.
    if (TERMINAL.has(s.status)) {
      s.lastSeenAt = at;
      continue;
    }
    applyReading(s, reading, now);
  }
}

// Called by the Amazon run after its readings are in (under the state lock):
// an Order-level Shipment that mail found merges into the package Shipments
// the account's history now shows. They take over what it already told the
// user (no second "new"), its discovery date and a dismissal; a manual add of
// the same Order is left to the Amazon route's ownership rules.
export function absorbMailOrders(list, orderIds) {
  for (const orderId of new Set(orderIds)) {
    const order = list.find((s) => isOrderLevel(s, orderId) && s.connections.includes(KEY));
    const packages = packagesOf(list, orderId);
    if (!order || packages.length === 0) continue;
    for (const p of packages) {
      if (!p.notified && order.notified) p.notified = order.notified;
      if (order.discoveredAt < p.discoveredAt) p.discoveredAt = order.discoveredAt;
      if (order.dismissedAt && !p.dismissedAt) {
        p.dismissedAt = order.dismissedAt;
        p.dismissedAs = order.dismissedAs;
      }
    }
    order.connections = order.connections.filter((c) => c !== KEY);
    if (order.connections.length === 0) list.splice(list.indexOf(order), 1);
  }
}

const LOGIN_MESSAGES = {
  cancelled: "login: Login cancelled",
  "timed-out": "login: Login timed out after 15 min",
  server: "login: the mail server didn't start",
  refused: "login: Microsoft didn't hand out a sign-in code",
};

// `login mail`: Softeria's device-code sign-in. The code and the page to
// enter it on go into sources.json (`login.code`, `login.url`) for the
// Sources row and the banner, and to stdout for a terminal. Signing in is
// checked every 5 s until the 15-minute deadline; then the first sync runs.
export async function loginMail(deps) {
  const { stateDir, mcp, now, sleep, log, out } = deps;
  let result = "another-login";
  const code = await runLogin(KEY, deps, async (handle) => {
    const deadline = await handle.window();
    let server;
    try {
      server = await openServer(mcp, stateDir);
    } catch (e) {
      if (e.code !== "server" && e.code !== "network") throw e;
      result = "server";
      return 1;
    }
    try {
      result = await signIn(server, { handle, deadline, now, sleep, out });
    } catch (e) {
      if (e.code !== "server") throw e;
      result = "server";
    } finally {
      await server.close().catch(() => {});
    }
    if (result !== "ok") {
      if (result === "cancelled" || result === "timed-out") handle.outcome = result;
      return 1;
    }
    await tightenFiles(stateDir);
    handle.outcome = "ok";
    await handle.syncing();
    log("login: mail signed in, running its first sync");
    const counts = { synced: 0, failed: 0, network: 0, lookedUp: 0 };
    const finishRun = (sources) => {
      sources.offline = counts.network > 0 && counts.synced === 0;
    };
    const synced = await refreshMail({ ...deps, counts, finishRun, firstSync: true });
    result = synced?.ok === false ? synced.reason : "ok";
    return 0;
  });
  if (result === "ok") out("login: Signed in; first sync done");
  else if (LOGIN_MESSAGES[result]) log(LOGIN_MESSAGES[result]);
  else if (result !== "another-login") out(`login: Signed in, but the first sync stopped: ${result}`);
  return code;
}

// "ok", "cancelled", "timed-out" or "refused".
async function signIn(server, { handle, deadline, now, sleep, out }) {
  const first = await server.tool("login", { force: false });
  if (first.json?.status === "Already logged in" || first.json?.success === true) return "ok";
  const device = first.json?.error === "device_code_required" ? readDeviceCode(first.json.message) : null;
  if (!device) return "refused";
  await handle.code(device);
  out(`login: open ${device.url} and enter the code ${device.code}`);
  const cancelled = new Promise((resolve) => {
    if (handle.signal.aborted) resolve();
    handle.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  while (!handle.signal.aborted) {
    if (now().getTime() >= deadline.getTime()) return "timed-out";
    await Promise.race([sleep(POLL_MS), cancelled]);
    if (handle.signal.aborted) break;
    const check = await server.tool("verify-login", {});
    if (check.json?.success === true) return "ok";
  }
  return "cancelled";
}

// MSAL's device-code message: "To sign in, use a web browser to open the
// page https://microsoft.com/devicelogin and enter the code ABCD1234 to authenticate."
function readDeviceCode(message) {
  const url = String(message ?? "").match(/https:\/\/[^\s"]+?(?=[\s".,;]*(?:\s|$))/)?.[0];
  const code = String(message ?? "").match(/\bcode\s+([A-Z0-9][A-Z0-9-]{5,})\b/i)?.[1];
  return url && code ? { code, url } : null;
}

// `disconnect mail`'s sign-out (see disconnect.mjs, which then forgets the
// Connection and the Shipments only mail knew): Softeria's logout clears its
// token cache and selected account; our copies of its files go too, also
// when the server can't start. The server is not installed just for this.
export async function signOutMail({ stateDir, mcp, log }) {
  try {
    const server = await openServer(mcp, stateDir, { install: false });
    try {
      const answer = await server.tool("logout", {});
      if (answer.isError || answer.json?.error) log("disconnect: the mail server couldn't log out; removing its files directly");
    } finally {
      await server.close().catch(() => {});
    }
  } catch (e) {
    if (e.code !== "server" && e.code !== "network") throw e;
    log("disconnect: the mail server didn't start; removing its files directly");
  }
  await removeFiles(stateDir);
}
