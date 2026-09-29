// Amazon Order IDs added by hand (spec #21, "Merge and identity"). Until an
// account owns it, such an Order is one Order-level Shipment keyed
// `amazon:<orderId>` that links to the Order's page. Each account's run looks
// for it (see read.mjs) and records the answer in `probedBy`. The account
// whose orders list it owns it: its package Shipments take over, marked as
// added by hand, and the Order-level Shipment goes. While every readable
// account has said no, it is link-only.
import { hasDhlSide, releaseToDhl } from "../merge.mjs";
import { TERMINAL } from "../shipments.mjs";
import { orderDetailsUrl } from "./pages.mjs";

const LOOKING_UP = "Looking up…";
const LINK_ONLY = "Link only · no Amazon account";

const orderKey = (orderId) => `amazon:${orderId}`;
const isAmazonConnection = (c) => c.startsWith("amazon:");
const isOrderLevel = (s) => s.source === "Amazon" && s.key === orderKey(s.orderId);
const isManual = (s) => s.source === "Amazon" && Boolean(s.orderId) && s.connections.includes("manual");
const owner = (s) => s.connections.find(isAmazonConnection) ?? null;
const text = (estimateText) => ({ from: null, to: null, text: estimateText });

function orderLevelShipment(orderId, at, probedBy = []) {
  return {
    key: orderKey(orderId),
    direction: "Incoming",
    source: "Amazon",
    account: null,
    carrier: null,
    connections: ["manual"],
    title: orderId,
    status: "Unknown",
    estimate: text(LOOKING_UP),
    delayed: false,
    orderId,
    url: orderDetailsUrl(orderId),
    probedBy,
    linkOnly: false,
    changedAt: at,
    discoveredAt: at,
    lastSeenAt: null,
  };
}

// `add <orderId>`. Returns false when the Order is already tracked (its
// Shipments are then marked as added by hand).
export function addManualOrder(list, orderId, now) {
  const existing = list.filter((s) => s.source === "Amazon" && s.orderId === orderId);
  for (const s of existing) if (!s.connections.includes("manual")) s.connections.push("manual");
  if (existing.length > 0) return false;
  list.push(orderLevelShipment(orderId, now.toISOString()));
  return true;
}

// The Order IDs added by hand that the account `key` should look for: those it
// owns that aren't Terminal yet, and unowned ones it hasn't been asked about.
export function ordersToLookFor(list, key) {
  const ids = new Set();
  for (const s of list) {
    if (!isManual(s) || TERMINAL.has(s.status)) continue;
    const by = owner(s);
    if (by === key || (by === null && !(s.probedBy ?? []).includes(key))) ids.add(s.orderId);
  }
  return [...ids];
}

// Applies what one account's run found out (read.mjs `owned`/`notOwned`),
// after its readings were upserted. A package read for an Order that is still
// an Order-level row is ownership too, even though the account wasn't asked
// (it said no before, or the Order is link-only): its history lists the Order
// now, e.g. after history lag, so the Order never shows twice.
export function applyOwnership(list, key, label, { owned = [], notOwned = [], readings = [] }) {
  const listed = readings.map((r) => r.orderId)
    .filter((id) => list.some((s) => s.key === orderKey(id) && isOrderLevel(s) && isManual(s)));
  for (const orderId of new Set([...owned, ...listed])) {
    const order = list.find((s) => s.key === orderKey(orderId) && isOrderLevel(s));
    const packages = list.filter((s) => s.source === "Amazon" && s.orderId === orderId && s !== order);
    if (!order && !packages.some((s) => s.connections.includes("manual"))) continue;
    if (packages.length > 0) {
      for (const s of packages) if (!s.connections.includes("manual")) s.connections.push("manual");
      if (order) list.splice(list.indexOf(order), 1);
      continue;
    }
    // Owned, but no package read yet (page cap, or not shipped).
    if (!order.connections.includes(key)) order.connections.push(key);
    order.account = label;
    order.linkOnly = false;
    order.estimate = text(LOOKING_UP);
  }
  for (const orderId of notOwned) {
    const order = list.find((s) => s.key === orderKey(orderId) && isOrderLevel(s) && owner(s) === null);
    if (order && !order.probedBy.includes(key)) order.probedBy.push(key);
  }
}

// Removing a Connection (see disconnect.mjs): it no longer knows any
// Shipment, and a Shipment nothing else knows goes. When an Amazon account
// goes, a package Shipment that DHL still knows (the Sendungsliste, or its
// number added by hand) turns back into a DHL Shipment (merge.mjs); other
// package Shipments of a manual Order collapse back into one Order-level
// Shipment, and an Order-level one it owned loses its owner. Nobody has asked
// the removed Connection about anything any more.
export function releaseOwnership(list, key) {
  const result = [];
  const orphans = new Set();
  for (const s of list) {
    if (s.probedBy?.includes(key)) s.probedBy = s.probedBy.filter((c) => c !== key);
    if (!s.connections.includes(key)) {
      result.push(s);
      continue;
    }
    s.connections = s.connections.filter((c) => c !== key);
    const lostAccount = isAmazonConnection(key) && s.source === "Amazon" && owner(s) === null;
    if (lostAccount && !isOrderLevel(s) && hasDhlSide(s)) {
      result.push(releaseToDhl(s));
      continue;
    }
    if (lostAccount && isManual(s)) {
      if (isOrderLevel(s)) {
        s.account = null;
        result.push(s);
      } else if (!orphans.has(s.orderId)) {
        orphans.add(s.orderId);
        result.push(orderLevelShipment(s.orderId, s.discoveredAt));
      }
      continue;
    }
    if (s.connections.length > 0) result.push(s);
  }
  return result;
}

// An unowned manual Order is link-only once every account that can be read
// (Health ok or source-down) has been asked and said no; with none, at once.
export function settleLinkOnly(list, connections) {
  const readable = Object.entries(connections)
    .filter(([k, c]) => isAmazonConnection(k) && (c.health === "ok" || c.health === "source-down"))
    .map(([k]) => k);
  for (const s of list) {
    if (!isOrderLevel(s) || !isManual(s) || owner(s) !== null) continue;
    const linkOnly = readable.every((k) => s.probedBy.includes(k));
    if (linkOnly === s.linkOnly) continue;
    s.linkOnly = linkOnly;
    s.estimate = text(linkOnly ? LINK_ONLY : LOOKING_UP);
  }
}

export const hasManualOrders = (list) => list.some(isManual);
