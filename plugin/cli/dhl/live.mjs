// DHL's live tour data for a Shipment Out for delivery (#80): how many stops
// the van still has before the user's, and how much of its tour is left.
// It comes only with the authenticated enrichment (`sendungsdetails.liveTracking`;
// the anonymous lookup lacks it), so only the DHL Connection's sync reads it.
//
// Stored on the Shipment as `live`:
//   { stops, bucket, remaining, eta, samples }
//   stops     DHL's exact stop count (`countdown`), or null
//   bucket    without an exact count, the stop count DHL words as a code
//             (`countdownTextKey`), as the card says it: "20+", "~10", "2",
//             "next", or "~nn" for a code not seen yet; else null
//   remaining the fraction of the tour still to drive (`distance`, 0–1), or null
//   eta       an estimated arrival (ISO), from how fast `remaining` falls over
//             the last runs; null until it can be estimated
//   samples   up to 6 { at, remaining } readings of today's tour
// DHL's coordinates (`tourCoords`, `destinationCoords`) are never stored.
//
// `live` is not an update: it doesn't move changedAt, bring back a Dismissed
// Shipment or notify, except for the one "almost there" notification per
// Shipment (events.mjs), whose mark `almostNotified` sits on the Shipment
// itself so it outlasts the tour.

// Known codes as the card words them; any other CDnn is "~nn". Never invented.
const BUCKETS = { CD20: "20+", CD10: "~10", CD02: "2", CD01: "next" };
const MAX_SAMPLES = 6;
// Two runs closer than this are one sample (the later one counts).
const SAME_SAMPLE_MS = 60_000;

function bucketOf(key) {
  if (typeof key !== "string") return null;
  if (BUCKETS[key]) return BUCKETS[key];
  const m = key.match(/^CD(\d{1,3})$/);
  const n = m ? Number(m[1]) : 0;
  return n > 0 ? `~${n}` : null;
}

// The element's liveTracking → { stops, bucket, remaining }, or null when it
// says nothing we use (empty on delivery).
export function readLiveTracking(element) {
  const t = element?.sendungsdetails?.liveTracking;
  if (!t || typeof t !== "object") return null;
  const stops = Number.isInteger(t.countdown) && t.countdown > 0 ? t.countdown : null;
  // The exact count wins over the code.
  const bucket = stops === null ? bucketOf(t.countdownTextKey) : null;
  const remaining = typeof t.distance === "number" && t.distance >= 0 && t.distance <= 1 ? t.distance : null;
  if (stops === null && bucket === null && remaining === null) return null;
  return { stops, bucket, remaining };
}

const localDate = (date, timeZone) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

// Sets or clears `shipment.live` after a DHL reading was applied. Only an Out
// for delivery Shipment keeps it; its samples are today's only.
export function applyLive(shipment, reading, now, timeZone) {
  if (shipment.status !== "Out for delivery" || !reading) {
    delete shipment.live;
    return;
  }
  const today = localDate(now, timeZone);
  const samples = (shipment.live?.samples ?? []).filter((x) =>
    typeof x?.remaining === "number" && localDate(new Date(x.at), timeZone) === today && Date.parse(x.at) < now.getTime() - SAME_SAMPLE_MS);
  if (reading.remaining !== null) samples.push({ at: now.toISOString(), remaining: reading.remaining });
  const kept = samples.slice(-MAX_SAMPLES);
  shipment.live = {
    ...reading,
    eta: estimateArrival(kept, now, timeZone),
    samples: kept,
  };
}

// When `remaining` reaches 0 at the pace it fell over the samples (least
// squares), counted from the latest one. Only with two samples or more, a
// falling trend, and an arrival still today; never before now.
export function estimateArrival(samples, now, timeZone) {
  if (samples.length < 2) return null;
  const points = samples.map((x) => [Date.parse(x.at), x.remaining]);
  const n = points.length;
  const mt = points.reduce((a, [t]) => a + t, 0) / n;
  const mr = points.reduce((a, [, r]) => a + r, 0) / n;
  const num = points.reduce((a, [t, r]) => a + (t - mt) * (r - mr), 0);
  const den = points.reduce((a, [t]) => a + (t - mt) ** 2, 0);
  if (den === 0) return null;
  const slope = num / den; // per ms
  if (!(slope < 0)) return null;
  const [lastAt, lastRemaining] = points[n - 1];
  let eta = lastAt + lastRemaining / -slope;
  eta = Math.max(eta, now.getTime());
  if (localDate(new Date(eta), timeZone) !== localDate(now, timeZone)) return null;
  return new Date(Math.round(eta / 60_000) * 60_000).toISOString();
}

// Whether the 15-min DHL run (`refresh --source dhl --if-close`) has anything
// to watch: a Shipment the Sendungsliste lists that is Out for delivery, or
// whose delivery window includes today. Reads only the state, never the network.
const WINDOWLESS = new Set(["Delivered", "Returned", "Ready for pickup", "Problem"]);
export function deliveryClose(shipments, now, timeZone) {
  const today = localDate(now, timeZone);
  return shipments.some((s) => {
    if (!s.connections?.includes("dhl") || WINDOWLESS.has(s.status)) return false;
    if (s.status === "Out for delivery") return true;
    const from = String(s.estimate?.from ?? "").slice(0, 10);
    const to = String(s.estimate?.to ?? "").slice(0, 10);
    return from !== "" && to !== "" && from <= today && today <= to;
  });
}
