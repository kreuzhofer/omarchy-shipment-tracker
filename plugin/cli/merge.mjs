// One Shipment per parcel (spec #21, "Merge and Carrier"). An Amazon Shipment
// whose tracking number equals a DHL Shipment's is one Shipment: Source Amazon
// (its key, title, account and Order link), Carrier DHL, and DHL's Status,
// Estimate and Delayed, since DHL is the more detailed Source. The match key is
// the tracking number.
//
// `detail: "DHL"` marks an Amazon Shipment whose Status and Estimate now come
// from DHL; Amazon readings then only refresh its title. A DHL answer without
// tracking information (Unknown) doesn't take over: Amazon's own reading says
// more.
import { trackingPageUrl } from "./dhl/search.mjs";
import { applyReading } from "./shipments.mjs";

// The Shipment that holds this tracking number: the Amazon one when it is
// merged, else the DHL one keyed on the number.
export function findByTrackingNumber(list, trackingNumber) {
  return list.find((s) => s.source === "Amazon" && s.trackingNumber === trackingNumber)
    ?? list.find((s) => s.key === `dhl:${trackingNumber}`);
}

// Amazon Shipments whose Carrier is DHL get DHL's detail, from the Sendungsliste
// or the anonymous lookup.
export const carriedByDhl = (s) => s.source === "Amazon" && s.carrier === "DHL" && Boolean(s.trackingNumber);

// Applies what DHL says (see dhl/status.mjs) to a DHL or merged Shipment.
export function applyDhlReading(shipment, reading, now) {
  if (shipment.source !== "Amazon") return applyReading(shipment, reading, now);
  if (shipment.detail !== "DHL") {
    if (reading.status === "Unknown") return;
    takeOver(shipment);
  }
  // The item's title from the Order beats DHL's sender name.
  applyReading(shipment, { ...reading, title: null }, now);
}

// Applies an Amazon tracker reading: all of it, or only the title once DHL
// provides the detail.
export function applyAmazonReading(shipment, reading, now) {
  if (shipment.detail !== "DHL") return applyReading(shipment, reading, now);
  if (reading.title) shipment.title = reading.title;
  shipment.lastSeenAt = now.toISOString();
}

// Folds the DHL Shipment with the same tracking number into this Amazon
// Shipment, if there is one: the Connections that know it, its notification
// mark and, when DHL knows the number, DHL's detail. Returns whether it merged.
export function absorbDhlTwin(list, amazon) {
  if (!amazon.trackingNumber) return false;
  const i = list.findIndex((s) => s !== amazon && s.key === `dhl:${amazon.trackingNumber}`);
  if (i < 0) return false;
  const [dhl] = list.splice(i, 1);
  for (const c of dhl.connections) if (!amazon.connections.includes(c)) amazon.connections.push(c);
  // A DHL number added by hand stays one when the Amazon side goes (releaseToDhl).
  if (dhl.connections.includes("manual")) amazon.manualTrackingNumber = true;
  if (dhl.discoveredAt < amazon.discoveredAt) amazon.discoveredAt = dhl.discoveredAt;
  const detailed = dhl.status !== "Unknown" && Boolean(dhl.lastSeenAt);
  if (detailed) {
    takeOver(amazon);
    for (const field of ["status", "estimate", "delayed", "lastWindowTo", "terminalAt", "changedAt", "direction", "trackingEvent", "live"]) {
      if (dhl[field] === undefined) delete amazon[field];
      else amazon[field] = dhl[field];
    }
  }
  // What the DHL Shipment's notifications already covered stays covered (see
  // events.mjs): the parcel isn't new under its Amazon key, and a Status DHL
  // already announced isn't announced again.
  if (dhl.notified && (detailed || !amazon.notified)) amazon.notified = dhl.notified;
  // A dismissal of either stays until the merged Shipment gets a real update.
  if (dhl.dismissedAt && !amazon.dismissedAt) {
    amazon.dismissedAt = dhl.dismissedAt;
    amazon.dismissedAs = dhl.dismissedAs;
  }
  // Nor is its "almost there" notification sent twice (see events.mjs).
  if (dhl.almostNotified) amazon.almostNotified = true;
  return true;
}

// Whether this Amazon Shipment, having lost its Amazon account, still has a
// DHL side: the Sendungsliste lists it, or its DHL number was added by hand.
export const hasDhlSide = (s) => Boolean(s.trackingNumber)
  && (s.connections.includes("dhl") || (s.manualTrackingNumber === true && s.connections.includes("manual")));

// The other way round, when the Amazon account is removed: the Shipment turns
// back into a DHL Shipment keyed on its tracking number. It keeps its
// Connections (a "manual" mark included), DHL's detail, its notification mark
// and a dismissal, so nothing is announced again; the Order's title stays until
// DHL names a sender. Amazon's own Estimate no longer counts towards Delayed,
// and its item image goes (a DHL card has none).
export function releaseToDhl(s) {
  if (s.detail !== "DHL") {
    s.delayed = false;
    delete s.lastWindowTo;
  }
  s.key = `dhl:${s.trackingNumber}`;
  s.source = "DHL";
  s.account = null;
  s.carrier = "DHL";
  s.url = trackingPageUrl(s.trackingNumber);
  for (const field of ["orderId", "detail", "probedBy", "linkOnly", "manualTrackingNumber", "imageUrl", "image"]) delete s[field];
  return s;
}

// From now on DHL's readings set Status, Estimate and Delayed; Amazon's
// earlier promise doesn't count towards Delayed.
function takeOver(shipment) {
  shipment.detail = "DHL";
  shipment.delayed = false;
  delete shipment.lastWindowTo;
}
