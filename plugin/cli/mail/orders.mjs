// What mail does to the list (#59, revising #10 and #34): mail discovers and
// enriches, it never decides a Status. The authorities are the Carrier (DHL's
// Sendungsliste or anonymous lookup), then the Amazon account's pages.
//
// - An Amazon Order only mail knows is one Order-level Shipment
//   `amazon:<orderId>` whose Status stays Unknown. It carries what the last
//   mail said (`mail`: step, date, estimate) and shows it as `hint`
//   ("Shipped · per mail, 15 Sep"), or "Status unknown" once the mail's
//   estimate is more than 3 days past. It never notifies (events.mjs).
// - Every connected Amazon account looks for it like for a manual Order ID
//   (amazon/manual.mjs). Once an account reads its packages, they replace it
//   (absorbMailOrders), quietly when the row was already shown.
// - A DHL number found in mail becomes a watched DHL Shipment, like a manual
//   add (addMailNumbers), with what the mail says about the item.
// - A DHL Shipment the list already has gets its item from the mail a search
//   for its number found (applyItemSearches), once.
import { orderDetailsUrl } from "../amazon/pages.mjs";
import { localDate } from "../amazon/status.mjs";
import { markOf } from "../dismiss.mjs";
import { dayLabel, windowText } from "../estimate.mjs";
import { findByTrackingNumber } from "../merge.mjs";
import { isDropped } from "../retention.mjs";
import { manualDhlShipment, TERMINAL } from "../shipments.mjs";

export const KEY = "mail";
const STALE_DAYS = 3;
export const STATUS_UNKNOWN = "Status unknown";

const isOrderLevel = (s) => s.source === "Amazon" && Boolean(s.orderId) && s.key === `amazon:${s.orderId}`;
export const isMailOrder = (s) => isOrderLevel(s) && s.connections.includes(KEY);
const packagesOf = (list, orderId) => list.filter((s) => s.source === "Amazon" && s.orderId === orderId && !isOrderLevel(s));
const estimateOf = (e) => (e?.from ? { from: e.from, to: e.to ?? e.from, text: windowText(e.from, e.to ?? e.from) } : null);

function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// "Shipped · per mail, 15 Sep", or "Status unknown" once the estimate's last
// day is more than 3 days past (a newer mail brings a new estimate).
function hintOf(mail, now, timeZone) {
  const stale = mail.step !== "Delivered" && mail.estimate?.to
    && localDate(now, timeZone) > addDays(mail.estimate.to, STALE_DAYS);
  if (stale || !mail.step) return STATUS_UNKNOWN;
  return `${mail.step} · per mail, ${dayLabel(localDate(new Date(mail.at), timeZone)).slice(4)}`;
}

// Hint and Estimate from `s.mail`; a change counts as the row's last change.
// A manual Order ID keeps its own Estimate line ("Looking up…", "Link only").
function settleHint(s, now, timeZone) {
  const hint = hintOf(s.mail, now, timeZone);
  const estimate = s.connections.includes("manual") ? s.estimate : estimateOf(s.mail.estimate);
  if (hint === s.hint && JSON.stringify(estimate) === JSON.stringify(s.estimate)) return;
  s.hint = hint;
  s.estimate = estimate;
  s.changedAt = now.toISOString();
}

// The mailbox's Orders (status.mjs `readMails`), applied under the state lock.
export function applyMailOrders(shipments, orders, dropped, now, timeZone) {
  const list = shipments.shipments;
  const at = now.toISOString();
  for (const order of orders) {
    const key = `amazon:${order.orderId}`;
    if (isDropped(dropped, key) || [...dropped].some((d) => d.startsWith(`${key}#`))) continue;
    // An account already reads this Order's Shipments.
    if (packagesOf(list, order.orderId).length > 0) continue;
    let s = list.find((x) => x.key === key);
    if (!s) {
      s = {
        key, direction: "Incoming", source: "Amazon", account: null, carrier: null, connections: [],
        title: order.orderId, status: "Unknown", estimate: null, delayed: false,
        orderId: order.orderId, url: orderDetailsUrl(order.orderId), probedBy: [],
        changedAt: at, discoveredAt: at, lastSeenAt: null,
      };
      list.push(s);
    }
    if (!s.connections.includes(KEY)) s.connections.push(KEY);
    // A row from before #59 is migrated before this mail is applied, else
    // its mail Status would stay (the migration below only sees rows the
    // mailbox no longer names).
    const legacy = isLegacy(s) ? { changedAt: s.changedAt } : null;
    if (legacy) migrate(s, now, timeZone);
    s.probedBy ??= [];
    if (order.title) s.title = order.title;
    s.mail = { step: order.step, at: order.at, estimate: order.estimate };
    // A newer mail is a real update for a dismissed row (dismiss.mjs); the
    // mail the migration stands in for is not, nor a change of the row.
    s.trackingEvent = `mail@${order.at}`;
    s.lastSeenAt = at;
    settleHint(s, now, timeZone);
    if (legacy) {
      s.changedAt = legacy.changedAt;
      if (s.dismissedAt) s.dismissedAs = markOf(s);
    }
  }
}

// Every run that gets to the mailbox, read or not (under the state lock):
// rows from before #59 lose the Status mail gave them, quietly; hints age;
// Orders an account now reads are handed over.
export function settleMailOrders(shipments, now, timeZone) {
  for (const s of shipments.shipments) {
    if (!isMailOrder(s)) continue;
    if (isLegacy(s)) migrate(s, now, timeZone);
    settleHint(s, now, timeZone);
  }
  absorbMailOrders(shipments.shipments);
}

// Before #59 the sender decided the row's Status. It becomes the hint's step;
// the row keeps its title, Estimate and dates. Nothing is announced, and a
// dismissed row stays dismissed. An Order-level row mail knows never has a
// Status of its own (an account's readings are package rows), so any Status
// is mail's: also on rows #65's first runs half-migrated (a `mail` hint, but
// the old Status kept, Terminal ones included).
const LEGACY_STEPS = { Announced: "Ordered", "In transit": "Shipped", "Out for delivery": "Out for delivery", Delivered: "Delivered" };
const isLegacy = (s) => !s.mail || s.status !== "Unknown";
function migrate(s, now, timeZone) {
  s.mail ??= {
    step: LEGACY_STEPS[s.status] ?? null,
    at: s.lastSeenAt ?? s.changedAt,
    estimate: s.status === "Delivered" || !s.estimate?.from ? null : { from: s.estimate.from, to: s.estimate.to ?? s.estimate.from },
  };
  s.status = "Unknown";
  s.delayed = false;
  delete s.lastWindowTo;
  delete s.terminalAt;
  s.probedBy ??= [];
  if (s.notified) s.notified = { status: "Unknown", delayed: false };
  s.hint = hintOf(s.mail, now, timeZone);
  if (!s.connections.includes("manual")) s.estimate = estimateOf(s.mail.estimate);
  if (s.dismissedAt) s.dismissedAs = markOf(s);
}

// Called by the Amazon run after its readings are in, and by the mail run
// (under the state lock): an Order-level row mail knows goes once an account
// has read its packages. They keep its discovery date and a dismissal; when
// the row was already shown, the account's first reading announces nothing
// (Status now comes from the account). A mail title or Estimate only fills
// what the account didn't give. The packages stay looked for like a manual
// Order's (amazon/manual.mjs), even when the history no longer lists them.
// A manual add of the same Order is left to the Amazon route's ownership rules.
export function absorbMailOrders(list) {
  for (const order of list.filter(isMailOrder)) {
    const packages = packagesOf(list, order.orderId);
    if (packages.length === 0) continue;
    for (const p of packages) {
      if (!p.notified && order.notified && p.lastSeenAt) p.notified = { status: p.status, delayed: p.delayed === true };
      if (order.discoveredAt < p.discoveredAt) p.discoveredAt = order.discoveredAt;
      if (order.dismissedAt && !p.dismissedAt) {
        p.dismissedAt = order.dismissedAt;
        p.dismissedAs = order.dismissedAs;
      }
      if ((!p.title || p.title === "Amazon Order") && order.title && order.title !== order.orderId) p.title = order.title;
      if (!p.estimate && !TERMINAL.has(p.status)) p.estimate = estimateOf(order.mail?.estimate);
      p.fromMail = true;
    }
    order.connections = order.connections.filter((c) => c !== KEY && !c.startsWith("amazon:"));
    for (const field of ["mail", "hint", "trackingEvent"]) delete order[field];
    if (order.connections.length === 0) list.splice(list.indexOf(order), 1);
  }
}

// DHL numbers found in mail (numbers.mjs, with item.mjs's `item`), under the
// state lock: each new one is watched like a manual add (Status from the
// anonymous lookup, Incoming, never "new"). A number already tracked, or
// dropped by retention, is left alone. Returns how many were added.
export function addMailNumbers(shipments, numbers, dropped, now) {
  let added = 0;
  for (const { trackingNumber, item } of numbers) {
    if (isDropped(dropped, `dhl:${trackingNumber}`) || findByTrackingNumber(shipments.shipments, trackingNumber)) continue;
    const s = manualDhlShipment(trackingNumber, now);
    s.connections = [KEY];
    // Its mail already went through the item ladder: no search for it.
    s.mailSearchedAt = now.toISOString();
    if (item) Object.assign(s, item);
    shipments.shipments.push(s);
    added++;
  }
  return added;
}

// The searches for tracking numbers (connection.mjs), under the state lock:
// each DHL Shipment searched for is marked, so it's never searched again, and
// gets the item the mail names. Nothing else changes: not the Status, nor
// the last change, nor anything that notifies. Returns how many got an item.
export function applyItemSearches(shipments, searched, now) {
  let named = 0;
  for (const { trackingNumber, item } of searched) {
    const s = shipments.shipments.find((x) => x.key === `dhl:${trackingNumber}`);
    if (!s || s.itemTitle) continue;
    s.mailSearchedAt = now.toISOString();
    if (item) {
      Object.assign(s, item);
      named++;
    }
  }
  return named;
}
