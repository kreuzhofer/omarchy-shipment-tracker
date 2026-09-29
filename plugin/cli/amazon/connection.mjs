// Amazon Connections: one labelled amazon.de account each, with its own
// Chrome profile under the data dir and a fixed debugging port (spec #21,
// "Source adapters"). No Amazon password is ever stored: the profile keeps
// Amazon's own session cookie, and Chrome keeps any saved password in the
// keyring (--password-store=gnome-libsecret), never in our files.
import { mkdir, rm } from "node:fs/promises";
import { connectionRecord, recordFailure, recordOk } from "../health.mjs";
import { nextAmazonPort } from "../ports.mjs";
import { applyReading } from "../shipments.mjs";
import { readState, updateState } from "../state.mjs";
import { openAccountBrowser, profileDirFor } from "./browser.mjs";
import { orderDetailsUrl } from "./pages.mjs";
import { readAccount, waitForSignIn } from "./read.mjs";
import { localHour } from "./status.mjs";

export const connectionKey = (label) => `amazon:${label}`;
const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,23}$/u;
const QUIET_FROM = 23;
const QUIET_TO = 7;
const LOGIN_DEADLINE_MS = 15 * 60_000;

const MESSAGES = (label) => ({
  "signed-out": `Amazon · ${label} needs a login`,
  challenge: `Amazon · ${label} asks for a security check`,
  shape: "Amazon changed its data format · an update of the tracker is needed",
  browser: `Amazon · ${label} can't be read: Chrome didn't start`,
  network: `Amazon · ${label} can't be read`,
});

const amazonConnections = (sources) => Object.entries(sources.connections)
  .filter(([key]) => key.startsWith("amazon:"));

// Quiet hours 23:00–07:00 (local time) skip Amazon; DHL and mail run on.
export const inQuietHours = (now, timeZone) => {
  const hour = localHour(now, timeZone);
  return hour >= QUIET_FROM || hour < QUIET_TO;
};

// `accounts add <label> --accept-risk`: registers the account as not set up.
export async function addAccount(label, { acceptRisk }, { stateDir, now }) {
  if (!LABEL.test(label ?? "")) return { error: "A label is 1–24 letters, digits, spaces, - or _, e.g. Personal." };
  if (!acceptRisk) return { error: "amazon.de's Conditions of Use forbid robots; pass --accept-risk to accept that risk for this account." };
  return updateState(stateDir, ({ sources }) => {
    const taken = amazonConnections(sources);
    if (taken.some(([, c]) => c.label.toLowerCase() === label.toLowerCase())) return { error: `An Amazon account called ${label} already exists.` };
    const port = nextAmazonPort(new Set(taken.map(([, c]) => c.port)));
    const at = now().toISOString();
    Object.assign(connectionRecord(sources, connectionKey(label)), { since: at, label, riskAcceptedAt: at, port });
    return { ok: true };
  });
}

// `accounts remove <label>`: deletes the profile and the Shipments known only
// through this account.
export async function removeAccount(label, { stateDir, env }) {
  const key = connectionKey(label);
  const removed = await updateState(stateDir, ({ sources, shipments }) => {
    if (!sources.connections[key]) return false;
    delete sources.connections[key];
    shipments.shipments = shipments.shipments.filter((s) => {
      s.connections = s.connections.filter((c) => c !== key);
      return s.connections.length > 0;
    });
    return true;
  });
  if (removed) await rm(profileDirFor(env, label), { recursive: true, force: true });
  return removed;
}

// Part of `refresh`: each Amazon account in turn (one Chrome at a time).
// Accounts that are not set up or need a login are not attempted. `counts`
// is the run's tally, used for the offline rule; `finishRun(sources, at)`
// records the run. `only` limits it to one Connection key.
export async function refreshAmazon({ stateDir, env, now, chrome, sleep, timeZone, log, counts, finishRun, only = null }) {
  const snapshot = await readState(stateDir);
  const due = amazonConnections(snapshot.sources)
    .filter(([key, c]) => (only === null || key === only) && (c.health === "ok" || c.health === "source-down"));
  if (due.length === 0) return;
  if (inQuietHours(now(), timeZone)) {
    log(`refresh: amazon skipped (quiet hours), ${due.length} account(s)`);
    return;
  }
  for (const [key, conn] of due) {
    const known = (k) => snapshot.shipments.shipments.find((s) => s.key === k);
    const result = await runAccount(conn, { env, chrome, sleep, now, timeZone, known, hidden: true });
    if (result.reason === "busy") {
      log("refresh: amazon account busy, skipped");
      continue;
    }
    await applyAccountRun(stateDir, key, result, { now, counts, log, finishRun });
  }
}

async function runAccount(conn, { env, chrome, sleep, now, timeZone, known, hidden, tab: openTab }) {
  let tab = openTab;
  try {
    tab ??= await openAccountBrowser(chrome, { profileDir: profileDirFor(env, conn.label), port: conn.port, hidden });
    return await readAccount(tab, { known, sleep, now, timeZone, historyLoaded: Boolean(openTab) });
  } catch (e) {
    if (e.code === "busy") return { reason: "busy" };
    if (e.code !== "browser") throw e;
    return { reason: "browser", readings: [], pages: 0, unmapped: 0 };
  } finally {
    await tab?.close().catch(() => {});
  }
}

// Applies one account's readings under the state lock, then its Health.
async function applyAccountRun(stateDir, key, result, { now, counts, log, finishRun, firstSync = false }) {
  const { reason, readings } = result;
  if (reason === "network") counts.network++;
  if (reason) counts.failed++;
  else counts.synced++;
  await updateState(stateDir, ({ shipments, sources }) => {
    const conn = sources.connections[key];
    if (!conn) return; // removed while the run was in flight
    const at = now();
    for (const reading of readings) upsert(shipments.shipments, reading, conn, key, at);
    // A Login that reached the order history has proven the session, even if
    // its first sync then fails for another reason.
    if (firstSync && conn.health !== "ok") {
      conn.health = "ok";
      conn.reason = null;
      conn.message = null;
      conn.since = at.toISOString();
    }
    if (reason) {
      // Offline is not an error: a network failure counts only when something
      // else in this run got through.
      const countNetwork = firstSync || counts.synced > 0 || counts.lookedUp > 0;
      recordFailure(conn, at, reason, { message: MESSAGES(conn.label)[reason] ?? null, countNetwork });
    } else {
      recordOk(conn, at, shipments.shipments.filter((s) => s.connections.includes(key)).length);
    }
    finishRun(sources, at);
  });
  log(`refresh: amazon read ${result.pages} page(s), ${readings.length} Shipment(s)`
    + `${result.unmapped ? `, ${result.unmapped} unmapped` : ""}${reason ? `, stopped: ${reason}` : ""}`);
}

function upsert(list, reading, conn, key, now) {
  let s = list.find((x) => x.key === reading.key);
  const at = now.toISOString();
  if (!s) {
    s = {
      key: reading.key,
      direction: "Incoming",
      source: "Amazon",
      account: conn.label,
      carrier: null,
      connections: [key],
      title: reading.title || "Amazon Order",
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
  if (!s.connections.includes(key)) s.connections.push(key);
  if (reading.carrier) s.carrier = reading.carrier;
  if (reading.trackingNumber) s.trackingNumber = reading.trackingNumber;
  applyReading(s, reading, now);
}

// `login amazon:<label>`: opens the account's profile visibly on amazon.de;
// once the order history loads, the window moves to the hidden workspace and
// the first sync runs in the same Chrome. Returns "ok", "cancelled",
// "timed-out", "browser" or "unknown-account".
export async function loginAmazon(label, { stateDir, env, now, chrome, sleep, timeZone, log }) {
  const key = connectionKey(label);
  const { sources, shipments } = await readState(stateDir);
  const conn = sources.connections[key];
  if (!conn) return "unknown-account";
  const profileDir = profileDirFor(env, label);
  await mkdir(profileDir, { recursive: true, mode: 0o700 });

  let tab;
  try {
    tab = await openAccountBrowser(chrome, { profileDir, port: conn.port, hidden: false });
  } catch (e) {
    if (e.code === "busy" || e.code === "browser") return "browser";
    throw e;
  }
  let handedOver = false;
  try {
    const deadline = new Date(now().getTime() + LOGIN_DEADLINE_MS);
    const signedIn = await waitForSignIn(tab, { now, sleep, deadline });
    if (signedIn !== "ok") return signedIn;
    await tab.hide();
    const known = (k) => shipments.shipments.find((s) => s.key === k);
    handedOver = true;
    const result = await runAccount(conn, { env, chrome, sleep, now, timeZone, known, tab });
    const counts = { synced: 0, failed: 0, network: 0, lookedUp: 0 };
    const finishRun = (sources) => {
      sources.offline = counts.network > 0 && counts.network === counts.failed && counts.synced === 0 && counts.lookedUp === 0;
    };
    await applyAccountRun(stateDir, key, result, { now, counts, log, finishRun, firstSync: true });
    return result.reason ? result.reason : "ok";
  } finally {
    if (!handedOver) await tab.close().catch(() => {});
  }
}
