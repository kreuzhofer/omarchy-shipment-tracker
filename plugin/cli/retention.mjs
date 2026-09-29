// Retention (spec #21, "Retention", from #20): the widget keeps at most 30
// days of data, and a dropped Shipment never comes back as new.
//
// - A Terminal Shipment is dropped 30 days after it turned Terminal.
// - Any other Shipment is dropped 30 days after its last change, once
//   discovery no longer returns it. A Shipment a Connection still lists (or
//   the Carrier still knows, for a manual add) stays, so a stuck parcel
//   doesn't vanish; one whose Connection can't be read right now (failed,
//   needs a login, quiet hours) counts as still returned, so a failed run
//   never deletes anything.
// - `dropped[]` keeps only the key and the drop date, pruned after 120 days.
//   Discovery ignores these keys (DHL's Sendungsliste lists archived
//   Shipments for 80+ days), and they never produce events.
import { TERMINAL } from "./shipments.mjs";

const DAY_MS = 864e5;
const KEEP_DAYS = 30;
const DROPPED_DAYS = 120;

// The keys discovery must ignore.
export const droppedKeys = (shipments) => new Set((shipments.dropped ?? []).map((d) => d.key));
// Whether discovery must ignore `key`: it was dropped, or it is a package of a
// dropped Order-level Shipment (`amazon:<orderId>#<n>` of `amazon:<orderId>`).
export const isDropped = (dropped, key) => dropped.has(key) || dropped.has(String(key).replace(/#[^#]*$/, ""));

// Whether a Connection that knows the Shipment would still return it: its
// last successful read saw it, or it hasn't been read successfully yet. For a
// manual add or a DHL number found in mail: the Carrier knows the number.
function stillReturned(s, sources) {
  return (s.connections ?? []).some((c) => {
    if (c === "manual" || (c === "mail" && s.source === "DHL")) return s.status !== "Unknown";
    const conn = sources.connections?.[c];
    if (!conn) return false;
    return !conn.lastOk || (Boolean(s.lastSeenAt) && s.lastSeenAt >= conn.lastOk);
  });
}

const olderThan = (iso, days, now) => Boolean(iso) && now.getTime() - Date.parse(iso) >= days * DAY_MS;

function expired(s, sources, now) {
  if (TERMINAL.has(s.status)) return olderThan(s.terminalAt ?? s.changedAt, KEEP_DAYS, now);
  return olderThan(s.changedAt, KEEP_DAYS, now) && !stillReturned(s, sources);
}

// Drops what is due and prunes dropped[] (under the state lock). A merged
// Amazon Shipment also drops its DHL key, so the Sendungsliste can't bring
// the parcel back as a DHL Shipment. Returns how many Shipments were dropped.
export function applyRetention({ shipments, sources }, now) {
  const at = now.toISOString();
  const dropped = (shipments.dropped ?? [])
    .filter((d) => typeof d?.key === "string" && now.getTime() - Date.parse(d.at) <= DROPPED_DAYS * DAY_MS);
  const known = new Set(dropped.map((d) => d.key));
  const keep = [];
  let count = 0;
  for (const s of shipments.shipments) {
    if (!expired(s, sources, now)) {
      keep.push(s);
      continue;
    }
    count++;
    for (const key of [s.key, s.trackingNumber ? `dhl:${s.trackingNumber}` : null]) {
      if (key && !known.has(key)) {
        known.add(key);
        dropped.push({ key, at });
      }
    }
  }
  shipments.shipments = keep;
  shipments.dropped = dropped;
  return count;
}
