// Dismissed Shipments (CONTEXT.md, #35). `dismiss <key>` stamps the Shipment
// with `dismissedAt` and `dismissedAs`, what it showed when the user dismissed
// it. A refresh brings it back once it gets a real update: its Status,
// Estimate or Delayed differs from `dismissedAs`, or its latest tracking event
// does. Refreshes that find nothing new leave it hidden.
//
// Like the notification mark (events.mjs), this compares against a mark on the
// Shipment rather than against the previous reading, so overlapping runs and
// merges can't lose an update. Notifications, retention and the "need you"
// rules of the CLI ignore dismissals; the plugin hides the row and leaves it
// out of its summary and the bar icon's active state.

// An Estimate as a day or window (from/to); Amazon rewords its promise as the
// day comes closer ("morgen" → "heute"), which is not an update. Estimates
// without a day (a Problem's text) compare by their text.
const estimateKey = (e) => (e?.from || e?.to ? `${e.from ?? ""}/${e.to ?? ""}` : e?.text ?? null);

const markOf = (s) => ({
  status: s.status,
  estimate: estimateKey(s.estimate),
  delayed: s.delayed === true,
  trackingEvent: s.trackingEvent ?? null,
});

function updatedSince(s, mark) {
  const now = markOf(s);
  return now.status !== mark.status
    || now.estimate !== mark.estimate
    || now.delayed !== mark.delayed
    // A mark taken before the Shipment's events were recorded doesn't count
    // the first recorded event as new.
    || (mark.trackingEvent !== null && now.trackingEvent !== mark.trackingEvent);
}

// Returns an error message or null.
export function dismiss(shipments, key, now) {
  const s = shipments.shipments.find((x) => x.key === key);
  if (!s) return "No such Shipment.";
  s.dismissedAt = now.toISOString();
  s.dismissedAs = markOf(s);
  return null;
}

export function undismiss(shipments, key) {
  const s = shipments.shipments.find((x) => x.key === key);
  if (!s) return "No such Shipment.";
  clear(s);
  return null;
}

// Brings back every Dismissed Shipment that got a real update. Call at the end
// of a run, under the state lock, next to recordEvents.
export function clearUpdatedDismissals(shipments) {
  for (const s of shipments.shipments) {
    if (s.dismissedAt && (!s.dismissedAs || updatedSince(s, s.dismissedAs))) clear(s);
  }
}

function clear(s) {
  delete s.dismissedAt;
  delete s.dismissedAs;
}
