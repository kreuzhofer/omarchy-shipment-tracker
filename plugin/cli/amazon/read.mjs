// One Amazon account's run in its already open Chrome tab: the order history,
// then at most 6 tracker pages for non-Terminal Shipments, reached through the
// history's own links, with 4–12 s random gaps. Any sign-in or challenge page
// stops the run at once; nothing is ever submitted or clicked.
import { classifyPage, HISTORY_URL, inferCarrier, parseHistory, parseTracker } from "./pages.mjs";
import { amazonStatus, parseEstimate } from "./status.mjs";
import { TERMINAL } from "../shipments.mjs";

export const MAX_TRACKER_PAGES = 6;
const between = (min, max) => min + Math.random() * (max - min);

// Waits a moment after the load event before reading, like a person would.
const settle = (sleep) => sleep(Math.round(between(1000, 3000)));
const gap = (sleep) => sleep(Math.round(between(4000, 12000)));

// Returns { reason, readings, pages, unmapped }. `reason` is null for a full
// run, else the Health reason ("signed-out", "challenge", "shape", "network")
// that stopped it; readings taken before the stop are still returned.
// `known(key)` returns the Shipment already in shipments.json, if any.
// `historyLoaded`: the tab already shows the history (right after a Login).
export async function readAccount(tab, { known, sleep, now, timeZone, historyLoaded = false }) {
  const result = { reason: null, readings: [], pages: 0, unmapped: 0 };
  if (!historyLoaded) {
    result.pages++;
    if (!(await tab.navigate(HISTORY_URL))) return { ...result, reason: "network" };
    await settle(sleep);
  }
  const page = await readPage(tab);
  if (page.reason) return { ...result, reason: page.reason };
  const history = parseHistory(page.html);
  if (!history.ok) return { ...result, reason: "shape" };

  const targets = trackerPagesToRead(history.shipments, known);
  for (const target of targets) {
    await gap(sleep);
    result.pages++;
    if (!(await tab.navigate(target.href))) return { ...result, reason: "network" };
    await settle(sleep);
    const tracker = await readPage(tab);
    if (tracker.reason) return { ...result, reason: tracker.reason };
    const parsed = parseTracker(tracker.html);
    if (!parsed.ok) return { ...result, reason: "shape" };
    const reading = trackerReading(target, parsed, now(), timeZone);
    if (!reading.mapped) result.unmapped++;
    result.readings.push(reading);
  }
  return result;
}

// Terminal Shipments are never re-fetched. Of the rest, Shipments not seen yet
// come first (newest Order first), then the least recently read, so a long
// history is worked through over several runs.
function trackerPagesToRead(shipments, known) {
  return shipments
    .map((s, order) => ({ s, order, seen: known(shipmentKey(s)) }))
    .filter(({ seen }) => !TERMINAL.has(seen?.status))
    .sort((a, b) => (a.seen?.lastSeenAt ?? "").localeCompare(b.seen?.lastSeenAt ?? "") || a.order - b.order)
    .slice(0, MAX_TRACKER_PAGES)
    .map(({ s }) => s);
}

async function readPage(tab) {
  const url = await tab.url();
  const html = await tab.html();
  return { reason: classifyPage(url, html), html };
}

export const shipmentKey = ({ orderId, packageIndex }) => `amazon:${orderId}#${packageIndex}`;

function trackerReading(target, { state, carrierText }, now, timeZone) {
  const orderId = state.orderId;
  const packageIndex = String(state.packageIndex ?? target.packageIndex);
  const trackingNumber = state.trackingId || null;
  const { status, mapped } = amazonStatus(state);
  return {
    key: shipmentKey({ orderId, packageIndex }),
    orderId,
    status,
    mapped,
    estimate: parseEstimate(state.promise?.promiseMessage, now, timeZone),
    title: target.title,
    trackingNumber,
    carrier: inferCarrier(carrierText, trackingNumber),
  };
}

// Waits for the user to sign in in the visible window: success is the order
// history loading without a challenge. Returns "ok", "cancelled" (the user
// closed the tab or window) or "timed-out".
export async function waitForSignIn(tab, { now, sleep, deadline }) {
  let closed = false;
  tab.closed.then(() => { closed = true; });
  try {
    await tab.navigate(HISTORY_URL);
    while (!closed && now() < deadline) {
      const page = await readPage(tab);
      if (!page.reason && parseHistory(page.html).ok) return "ok";
      await sleep(2000);
    }
  } catch (e) {
    if (!closed && e.code !== "browser") throw e;
    return "cancelled";
  }
  return closed ? "cancelled" : "timed-out";
}
