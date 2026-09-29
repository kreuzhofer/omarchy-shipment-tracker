// The `mail` Connection: the user's Microsoft 365 mailbox, an optional,
// best-effort input (spec #21, "Microsoft 365 mail"; revised by #59). Mail
// discovers and enriches; it never decides a Status (see orders.mjs).
//
// Per run, two searches, each window applied here ($search can't be combined
// with $filter):
// - amazon.de mail of the last 30 days: each Order it names is kept as an
//   Order-level row with the last mail's hint, until an Amazon account reads
//   the Order (orders.mjs, amazon/manual.mjs);
// - mail mentioning DHL, of the last 14 days, from any sender: each DHL number
//   not tracked yet becomes a watched Shipment (numbers.mjs). What was shipped
//   comes from that mail (item.mjs), read as HTML in a second, short server
//   session when there is something new; that session failing only costs the
//   item info.
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
import { findByTrackingNumber } from "../merge.mjs";
import { droppedKeys, isDropped } from "../retention.mjs";
import { readState, updateState } from "../state.mjs";
import { itemInfo } from "./item.mjs";
import { lastAuthDetail, openServer, removeFiles, tightenFiles } from "./mcp.mjs";
import { findNumbers } from "./numbers.mjs";
import { addMailNumbers, applyMailOrders, KEY, settleMailOrders } from "./orders.mjs";
import { readMails } from "./status.mjs";

export { absorbMailOrders, KEY } from "./orders.mjs";
const SELECT = ["id", "receivedDateTime", "from", "subject", "body"];
const AMAZON_SEARCH = { search: '"from:amazon.de"', select: SELECT, top: 100 };
const AMAZON_WINDOW_DAYS = 30;
const DHL_SEARCH = { search: '"DHL"', select: SELECT, top: 50 };
const DHL_WINDOW_DAYS = 14;
// HTML bodies fetched per run for the item ladder; more new numbers wait.
const MAX_ITEM_MAILS = 5;
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

const daysBefore = (now, days) => new Date(now.getTime() - days * 864e5);

// One search: { messages } or { reason }.
async function search(server, stateDir, args) {
  const answer = await server.tool("list-mail-messages", args);
  if (answer.isError) {
    const detail = /Silent token acquisition failed/.test(answer.text) ? await lastAuthDetail(stateDir) : "";
    return { reason: failure(`${detail} ${answer.text}`) };
  }
  const messages = answer.json?.value;
  return Array.isArray(messages) ? { messages } : { reason: "shape" };
}

// Reads the mailbox: { ok: true, orders, numbers, ignored } or { ok: false, reason }.
// `known(trackingNumber)`: already tracked, so no item info is needed.
async function readMailbox({ stateDir, mcp, now, timeZone, known }) {
  let server;
  try {
    server = await openServer(mcp, stateDir);
  } catch (e) {
    if (e.code === "network") return { ok: false, reason: "network" };
    if (e.code === "server") return { ok: false, reason: "server" };
    throw e;
  }
  let amazon;
  let dhl;
  try {
    amazon = await search(server, stateDir, AMAZON_SEARCH);
    if (!amazon.reason) dhl = await search(server, stateDir, DHL_SEARCH);
  } catch (e) {
    if (e.code !== "server") throw e;
    return { ok: false, reason: "server" };
  } finally {
    await server.close().catch(() => {});
  }
  const reason = amazon.reason ?? dhl.reason;
  if (reason) return { ok: false, reason };
  const numbers = findNumbers(dhl.messages, daysBefore(now(), DHL_WINDOW_DAYS)).filter((n) => !known(n.trackingNumber));
  await addItemInfo(numbers, { stateDir, mcp });
  return { ok: true, ...readMails(amazon.messages, daysBefore(now(), AMAZON_WINDOW_DAYS), timeZone), numbers };
}

// The item ladder for each new number, on the mail's HTML body when it can be
// fetched (Softeria's list gives text bodies), else on its subject.
async function addItemInfo(numbers, { stateDir, mcp }) {
  const ids = [...new Set(numbers.map((n) => n.message.id).filter(Boolean))].slice(0, MAX_ITEM_MAILS);
  const html = new Map();
  if (ids.length > 0) {
    let server = null;
    try {
      server = await openServer(mcp, stateDir, { html: true });
      for (const id of ids) {
        const answer = await server.tool("get-mail-message", { "message-id": id, select: ["id", "body"] });
        const body = answer.json?.body;
        if (!answer.isError && body?.contentType === "html" && typeof body.content === "string") html.set(id, body.content);
      }
    } catch (e) {
      if (e.code !== "server" && e.code !== "network") throw e;
    } finally {
      await server?.close().catch(() => {});
    }
  }
  for (const n of numbers) {
    n.item = itemInfo(n.message, n.trackingNumber, html.get(n.message.id) ?? null);
    delete n.message;
  }
}

// Part of `refresh`, between DHL and Amazon. Not read: not set up, or a Login
// of it is running (except the Login's own first sync).
export async function refreshMail({ stateDir, mcp, now, timeZone, log, counts, finishRun, firstSync = false }) {
  const { sources, shipments } = await readState(stateDir);
  const conn = sources.connections?.[KEY];
  if (!mcp || !conn) return;
  if (!firstSync && (conn.health === "not-set-up" || conn.login)) return;
  const dropped = droppedKeys(shipments);
  const known = (n) => isDropped(dropped, `dhl:${n}`) || Boolean(findByTrackingNumber(shipments.shipments, n));
  const outcome = await readMailbox({ stateDir, mcp, now, timeZone, known });
  if (outcome.ok) counts.synced++;
  else {
    counts.failed++;
    if (outcome.reason === "network") counts.network++;
  }
  // Offline is not an error: a network failure counts once something else
  // in the run got through (else refresh.mjs counts it at the end, if so).
  const countNetwork = firstSync || counts.lookedUp > 0 || counts.synced > 0;
  const added = await updateState(stateDir, ({ shipments, sources }) => {
    const c = sources.connections?.[KEY];
    const at = now();
    // Disconnected while the run was in flight.
    if (!c || (c.health === "not-set-up" && !firstSync)) return 0;
    if (firstSync) markKnown(shipments);
    // A Login that got through has proven the mailbox, even if its first
    // sync then fails.
    if (firstSync && c.health !== "ok") {
      Object.assign(c, { health: "ok", reason: null, message: null, since: at.toISOString() });
    }
    let count = 0;
    if (!outcome.ok) {
      recordFailure(c, at, outcome.reason, { message: MESSAGES[outcome.reason] ?? null, countNetwork });
    } else {
      const dropped = droppedKeys(shipments);
      applyMailOrders(shipments, outcome.orders, dropped, at, timeZone);
      count = addMailNumbers(shipments, outcome.numbers, dropped, at);
      recordOk(c, at, shipments.shipments.filter((s) => s.connections.includes(KEY)).length);
    }
    settleMailOrders(shipments, at, timeZone);
    finishRun(sources, at);
    if (firstSync) {
      clearUpdatedDismissals(shipments);
      recordEvents(shipments, { firstSync: new Set([KEY]) });
      recordConnectionEvents(shipments, sources);
    }
    return count;
  });
  log(outcome.ok
    ? `refresh: mail ok, ${outcome.orders.length} Order(s), ${added} new DHL number(s)${outcome.ignored ? `, ${outcome.ignored} mail(s) ignored` : ""}`
    : `refresh: mail failed (${outcome.reason})`);
  return { ...outcome, counted: countNetwork };
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
