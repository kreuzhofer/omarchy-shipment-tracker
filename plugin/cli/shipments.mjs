// Shipment records in shipments.json. Terms follow CONTEXT.md.
import { trackingPageUrl } from "./dhl/search.mjs";
import { endsLater } from "./estimate.mjs";

export const TERMINAL = new Set(["Delivered", "Returned"]);
const AMAZON_ORDER_ID = /^\d{3}-\d{7}-\d{7}$/;
const TRACKING_NUMBER = /^[A-Z0-9]{8,40}$/;

// What the user typed into the add field → { kind, id } or { error }.
export function parseManualId(input) {
  const raw = String(input ?? "").trim();
  // The format decides the Source: an Amazon Order ID, else a DHL number.
  if (AMAZON_ORDER_ID.test(raw)) return { kind: "amazon", id: raw };
  const id = raw.replace(/\s+/g, "").toUpperCase();
  if (!TRACKING_NUMBER.test(id)) return { error: "That doesn't look like a tracking number." };
  return { kind: "dhl", id };
}

export function manualDhlShipment(trackingNumber, now) {
  const at = now.toISOString();
  return {
    key: `dhl:${trackingNumber}`,
    direction: "Incoming",
    source: "DHL",
    account: null,
    carrier: "DHL",
    connections: ["manual"],
    title: trackingNumber,
    status: "Unknown",
    estimate: { from: null, to: null, text: "Looking up…" },
    delayed: false,
    trackingNumber,
    url: trackingPageUrl(trackingNumber),
    changedAt: at,
    discoveredAt: at,
    lastSeenAt: null,
  };
}

// Applies what the Carrier currently says (see dhl/status.mjs) to a Shipment.
// Delayed: set when the delivery window ends later than the last one seen
// (`lastWindowTo` survives runs without a window), cleared on turning Terminal.
export function applyReading(shipment, reading, now) {
  const at = now.toISOString();
  const changed = shipment.status !== reading.status
    || JSON.stringify(shipment.estimate) !== JSON.stringify(reading.estimate);
  shipment.status = reading.status;
  shipment.estimate = reading.estimate;
  if (reading.title) shipment.title = reading.title;
  shipment.lastSeenAt = at;
  if (changed) shipment.changedAt = at;
  if (TERMINAL.has(reading.status)) {
    shipment.delayed = false;
    if (!shipment.terminalAt) shipment.terminalAt = at;
  } else if (reading.window) {
    if (shipment.lastWindowTo && endsLater(reading.window, shipment.lastWindowTo)) shipment.delayed = true;
    shipment.lastWindowTo = reading.window;
  }
}

// Takes back a manual add: drops the "manual" mark, and the Shipment itself
// when no Connection knows it. Returns an error message or null.
export function removeManual(shipments, key) {
  const i = shipments.shipments.findIndex((s) => s.key === key);
  if (i < 0) return "No such Shipment.";
  const s = shipments.shipments[i];
  if (!s.connections?.includes("manual")) return "Only Shipments added by hand can be removed.";
  s.connections = s.connections.filter((c) => c !== "manual");
  if (s.connections.length === 0) shipments.shipments.splice(i, 1);
  return null;
}
