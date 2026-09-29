// Shipment records in shipments.json. Terms follow CONTEXT.md.
import { trackingPageUrl } from "./dhl/search.mjs";

export const TERMINAL = new Set(["Delivered", "Returned"]);
const AMAZON_ORDER_ID = /^\d{3}-\d{7}-\d{7}$/;
const TRACKING_NUMBER = /^[A-Z0-9]{8,40}$/;

// What the user typed into the add field → { kind, id } or { error }.
export function parseManualId(input) {
  const raw = String(input ?? "").trim();
  if (AMAZON_ORDER_ID.test(raw)) return { error: "Amazon Order IDs can't be tracked yet." };
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
export function applyReading(shipment, reading, now) {
  const at = now.toISOString();
  const changed = shipment.status !== reading.status
    || JSON.stringify(shipment.estimate) !== JSON.stringify(reading.estimate);
  shipment.status = reading.status;
  shipment.estimate = reading.estimate;
  if (reading.title) shipment.title = reading.title;
  shipment.lastSeenAt = at;
  if (changed) shipment.changedAt = at;
  if (TERMINAL.has(reading.status) && !shipment.terminalAt) shipment.terminalAt = at;
}
