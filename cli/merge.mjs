// One Shipment per parcel (spec #21, "Merge and Carrier"). An Amazon Shipment
// whose tracking number equals a DHL Shipment's is one Shipment: Source Amazon
// (its key, title, account and Order link), Carrier DHL, and DHL's Status,
// Estimate and Delayed, since DHL is the more detailed Source. The match key is
// the tracking number. The same goes for DPD (#83): every Carrier that is
// looked up by number (carriers.mjs) is merged alike.
//
// `detail: "DHL"` (or "DPD") marks an Amazon Shipment whose Status and
// Estimate now come from that Carrier; Amazon readings then only refresh its
// title. A Carrier's answer without tracking information (Unknown) doesn't
// take over: Amazon's own reading says more.
import { carrierKey, carrierKeys, isNumberCarrier, isTrackingNumber, trackingPageUrl } from "./carriers.mjs";
import { applyReading } from "./shipments.mjs";

// The Shipment that holds this tracking number: the Amazon one when it is
// merged, else the Carrier's own one keyed on the number.
export function findByTrackingNumber(list, trackingNumber) {
  const keys = carrierKeys(trackingNumber);
  return list.find((s) => s.source === "Amazon" && s.trackingNumber === trackingNumber)
    ?? list.find((s) => keys.includes(s.key));
}

// The Carrier whose detail an Amazon Shipment gets (from the Sendungsliste or
// the anonymous lookup), or null: DHL or DPD, with a tracking number.
export const carrierDetailOf = (s) => (s.source === "Amazon" && isNumberCarrier(s.carrier) && isTrackingNumber(s.trackingNumber) ? s.carrier : null);

// Applies what the Carrier says (see dhl/status.mjs, dpd/status.mjs) to its
// own or a merged Shipment.
export function applyCarrierReading(shipment, reading, now, carrier = "DHL") {
  if (shipment.source !== "Amazon") return applyReading(shipment, reading, now);
  if (shipment.detail !== carrier) {
    if (reading.status === "Unknown") return;
    takeOver(shipment, carrier);
  }
  // The item's title from the Order beats the Carrier's sender name.
  applyReading(shipment, { ...reading, title: null }, now);
}

export const applyDhlReading = (shipment, reading, now) => applyCarrierReading(shipment, reading, now, "DHL");

// Applies an Amazon tracker reading: all of it, or only the title once a
// Carrier provides the detail.
export function applyAmazonReading(shipment, reading, now) {
  if (!shipment.detail) return applyReading(shipment, reading, now);
  if (reading.title) shipment.title = reading.title;
  shipment.lastSeenAt = now.toISOString();
}

// Folds the Carrier's own Shipment with the same tracking number (DHL or
// DPD) into this Amazon Shipment, if there is one: the Connections that know
// it, its notification mark and, when the Carrier knows the number, its
// detail. Returns whether it merged.
export function absorbDhlTwin(list, amazon) {
  if (!isTrackingNumber(amazon.trackingNumber)) return false;
  const keys = carrierKeys(amazon.trackingNumber);
  const i = list.findIndex((s) => s !== amazon && keys.includes(s.key));
  if (i < 0) return false;
  const [dhl] = list.splice(i, 1);
  for (const c of dhl.connections) if (!amazon.connections.includes(c)) amazon.connections.push(c);
  // A number added by hand stays one when the Amazon side goes (releaseToDhl).
  if (dhl.connections.includes("manual")) amazon.manualTrackingNumber = true;
  // A DPD Predict mail's window (mail/window.mjs) stays with the parcel.
  if (dhl.mailWindow) amazon.mailWindow = dhl.mailWindow;
  if (dhl.discoveredAt < amazon.discoveredAt) amazon.discoveredAt = dhl.discoveredAt;
  const detailed = dhl.status !== "Unknown" && Boolean(dhl.lastSeenAt);
  if (detailed) {
    takeOver(amazon, dhl.source);
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
// Carrier side: DHL's Sendungsliste lists it, or its DHL or DPD number was
// added by hand.
export const hasDhlSide = (s) => Boolean(s.trackingNumber)
  && (s.connections.includes("dhl") || (s.manualTrackingNumber === true && s.connections.includes("manual")));

// The other way round, when the Amazon account is removed: the Shipment turns
// back into a Shipment of its Carrier (DPD when Amazon named DPD, else DHL)
// keyed on its tracking number. It keeps its Connections (a "manual" mark
// included), the Carrier's detail, its notification mark and a dismissal, so
// nothing is announced again; the Order's title stays until the Carrier names
// a sender. Amazon's own Estimate no longer counts towards Delayed, and its
// item image goes (a Carrier's card has none).
export function releaseToDhl(s) {
  const carrier = s.carrier === "DPD" && !s.connections.includes("dhl") ? "DPD" : "DHL";
  if (s.detail !== carrier) {
    s.delayed = false;
    delete s.lastWindowTo;
  }
  s.key = carrierKey(carrier, s.trackingNumber);
  s.source = carrier;
  s.account = null;
  s.carrier = carrier;
  s.url = trackingPageUrl(carrier, s.trackingNumber);
  for (const field of ["orderId", "detail", "probedBy", "linkOnly", "manualTrackingNumber", "imageUrl", "image"]) delete s[field];
  return s;
}

// From now on the Carrier's readings set Status, Estimate and Delayed;
// Amazon's earlier promise doesn't count towards Delayed.
function takeOver(shipment, carrier) {
  shipment.detail = carrier;
  shipment.delayed = false;
  delete shipment.lastWindowTo;
}
