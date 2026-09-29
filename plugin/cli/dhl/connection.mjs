// The `dhl` Connection: the user's dhl.de Sendungsliste (Incoming and
// Outgoing), read over plain HTTP after `login dhl`.
//
// One sync = renew the ID token (saving the rotated refresh token first), the
// inbox call, then one authenticated `piececode=<all ids>` call. The inbox
// returns many elements as stubs (`hasCompleteDetails: false`); asking for
// every id at once returns the whole list complete. Asking for a subset turns
// the others back into stubs, so it is always all of them.
import { connectionRecord, recordFailure, recordOk } from "../health.mjs";
import { applyDhlReading, findByTrackingNumber } from "../merge.mjs";
import { manualDhlShipment, TERMINAL } from "../shipments.mjs";
import { renewIdToken } from "./auth.mjs";
import { search } from "./search.mjs";
import { readDhlElement } from "./status.mjs";

export const KEY = "dhl";

// Per-element fields that aren't Status, as data. Values the spec marks "to
// be confirmed" (#17: whether DHL names the Outgoing recipient, and where)
// slot in as further candidates.
const DIRECTIONS = { ANKOMMEND: "Incoming", EINGEHEND: "Incoming", ABGEHEND: "Outgoing", AUSGEHEND: "Outgoing" };
const TITLE_FIELDS = {
  Incoming: [(e) => e.sendungsinfo?.sendungsname],
  Outgoing: [(e) => e.sendungsdetails?.panEmpfaenger?.name, (e) => e.sendungsdetails?.empfaenger?.name, (e) => e.sendungsinfo?.sendungsname],
};

// What the Sendungsliste says about one element besides its Status:
// { trackingNumber, direction, title, complete }.
export function readListing(element) {
  const direction = DIRECTIONS[element?.sendungsinfo?.sendungsrichtung] ?? "Incoming";
  const title = TITLE_FIELDS[direction].map((f) => f(element)).find((v) => typeof v === "string" && v.trim() !== "");
  return {
    trackingNumber: element.id,
    direction,
    title: title?.trim() ?? null,
    complete: element.hasCompleteDetails !== false,
  };
}

// Returns { ok: true, elements } with every element of the Sendungsliste, or
// { ok: false, reason } ("not-set-up" | "expired" | "account-link-lost" |
// "empty-list" | "network" | "http" | "shape" | "rate-limited").
//
// The empty-list check (spec #21, check 3): a lost session also answers an
// empty list with HTTP 200. When the last successful sync listed something
// (`previousCount` > 0) and this one lists nothing, the token is renewed once
// more and the list asked again; still empty is `empty-list` (needs-login).
// An account that has always been empty stays ok. A Login's first sync passes
// no previousCount: a fresh login proves the session.
export async function syncDhl({ stateDir, transport, now, previousCount = 0 }) {
  let inbox = await readInbox({ stateDir, transport, now });
  if (!inbox.ok) return inbox;
  if (inbox.sendungen.length === 0 && previousCount > 0) {
    inbox = await readInbox({ stateDir, transport, now });
    if (!inbox.ok) return inbox;
    if (inbox.sendungen.length === 0) return { ok: false, reason: "empty-list" };
  }
  const ids = inbox.sendungen.map((e) => e?.id).filter((id) => typeof id === "string" && id !== "");
  if (ids.length !== inbox.sendungen.length) return { ok: false, reason: "shape" };
  if (ids.length === 0) return { ok: true, elements: [] };

  const enriched = await search(transport, { idToken: inbox.idToken, piececodes: ids });
  if (!enriched.ok) return enriched;
  return { ok: true, elements: enriched.sendungen.filter((e) => typeof e?.id === "string" && e.id !== "") };
}

// A token renewal, then the inbox call: { ok: true, idToken, sendungen } or a failure.
async function readInbox({ stateDir, transport, now }) {
  const token = await renewIdToken({ stateDir, transport, now });
  if (!token.ok) return token;
  const inbox = await search(transport, { idToken: token.idToken });
  if (!inbox.ok) return inbox;
  return { ok: true, idToken: token.idToken, sendungen: inbox.sendungen };
}

// Applies a sync's outcome to the state files (under the state lock). Returns
// the tracking numbers the Sendungsliste listed. Its Direction wins over a
// manual add's default. A number an Amazon Shipment carries goes to that
// Shipment (see merge.mjs). A failed sync never changes or deletes Shipments.
export function applyDhlSync({ shipments, sources }, outcome, now) {
  const listed = new Set();
  if (!outcome.ok && outcome.reason === "not-set-up") return listed;
  const connection = connectionRecord(sources, KEY);
  if (!outcome.ok) {
    recordFailure(connection, now, outcome.reason);
    return listed;
  }
  const at = now.toISOString();
  const dropped = new Set((shipments.dropped ?? []).map((d) => d.key));
  for (const element of outcome.elements) {
    const listing = readListing(element);
    const key = `dhl:${listing.trackingNumber}`;
    if (dropped.has(key) || listed.has(listing.trackingNumber)) continue;
    listed.add(listing.trackingNumber);
    let shipment = findByTrackingNumber(shipments.shipments, listing.trackingNumber);
    if (!shipment) {
      shipment = { ...manualDhlShipment(listing.trackingNumber, now), connections: [], estimate: null };
      shipments.shipments.push(shipment);
    }
    if (!shipment.connections.includes(KEY)) shipment.connections.push(KEY);
    shipment.direction = listing.direction;
    shipment.lastSeenAt = at;
    // Terminal Shipments never change again.
    if (TERMINAL.has(shipment.status)) continue;
    const reading = listing.complete ? readDhlElement(element) : null;
    if (reading) applyDhlReading(shipment, reading, now);
    if (listing.title && shipment.source === "DHL") shipment.title = listing.title;
  }
  recordOk(connection, now, outcome.elements.length);
  return listed;
}
