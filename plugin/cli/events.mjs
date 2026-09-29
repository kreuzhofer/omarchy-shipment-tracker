// Notification events (spec #21, "Event generation"). `refresh` writes the
// notifications of its run into shipments.json `events[]`, already filtered by
// the rules below and collapsed, with ids that keep increasing across runs. The
// plugin only gates them on its toggle and the last id it handled.
//
// How a run knows what changed: each Shipment carries `notified`, the Status
// and Delayed its events last covered. A run compares against that, not against
// a snapshot of its own, so two overlapping runs never announce the same change
// twice: whichever writes first moves the mark.
//
// A Shipment without a mark is new, unless it was never read (a manual add
// waiting for its first lookup; it is marked quietly once read). Shipments that
// already exist when a run starts get a mark first (markKnown), so state from
// before this rule, or written by a writer that doesn't record events (e.g. a
// Connection's own first sync), is never announced as new.

const INCOMING_STATUSES = ["Out for delivery", "Ready for pickup", "Problem", "Returning", "Delivered", "Returned"];

// Per Direction: which Statuses a transition into notifies, and whether
// becoming Delayed or being newly discovered does.
const RULES = {
  Incoming: { statuses: new Set(INCOMING_STATUSES), delayed: true, discovered: true },
  Outgoing: { statuses: new Set(["Delivered", "Problem", "Returning"]), delayed: false, discovered: false },
};

// More Shipment events than this in one run become one `summary`.
const COLLAPSE_ABOVE = 3;

// Connections that aren't discovery: a manual add is never "new".
const MANUAL = "manual";

const mark = (s) => ({ status: s.status, delayed: s.delayed === true });

// Marks every Shipment that has been read at least once and has no mark yet.
// Call at the start of a run, under the state lock.
export function markKnown(shipments) {
  for (const s of shipments.shipments) {
    if (!s.notified && s.lastSeenAt) s.notified = mark(s);
  }
}

// Connections whose next successful sync is their first: never synced ok
// (setup, or a first sync that failed). A Login adds its Connection on top,
// since a re-login's first sync may bring the whole backlog.
export function firstSyncConnections(sources) {
  const keys = new Set();
  for (const [key, c] of Object.entries(sources.connections ?? {})) {
    if (!c?.lastOk) keys.add(key);
  }
  return keys;
}

const who = (s) => (s.direction === "Outgoing" ? `To ${s.title}` : s.title);
// Who sent a new Shipment: the Amazon account for Amazon Orders (their title
// is the item), else the sender DHL names as the title.
const sender = (s) => (s.source === "Amazon" ? ["Amazon", s.account].filter(Boolean).join(" · ") : s.title);
const line = (...parts) => parts.filter((p) => typeof p === "string" && p !== "").join(" · ");

const EVENTS = {
  status: (s) => ({ kind: "status", key: s.key, status: s.status, title: s.status, body: line(who(s), s.estimate?.text), url: s.url }),
  delayed: (s) => ({ kind: "delayed", key: s.key, status: s.status, title: "Delayed", body: line(who(s), s.estimate?.text), url: s.url }),
  new: (s) => ({
    kind: "new", key: s.key, status: s.status, title: `New Shipment from ${sender(s)}`,
    body: line(sender(s) === s.title ? null : s.title, s.status, s.estimate?.text), url: s.url,
  }),
};

// Which event, if any, one Shipment gets this run (at most one: a notifying
// Status change wins over Delayed).
function eventKind(s, firstSync) {
  const rules = RULES[s.direction] ?? RULES.Incoming;
  const before = s.notified;
  if (!before) {
    const connections = s.connections ?? [];
    const discovered = !connections.includes(MANUAL) && connections.some((c) => !firstSync.has(c));
    return rules.discovered && discovered ? "new" : null;
  }
  if (s.status !== before.status && rules.statuses.has(s.status)) return "status";
  if (s.delayed === true && !before.delayed && rules.delayed) return "delayed";
  return null;
}

function summary(events, shipments) {
  const titles = events.map((e) => shipments.find((s) => s.key === e.key)?.title).filter(Boolean);
  const shown = titles.slice(0, COLLAPSE_ABOVE).join(", ");
  const more = titles.length - COLLAPSE_ABOVE;
  return {
    kind: "summary",
    count: events.length,
    title: `${events.length} Shipments updated`,
    body: more > 0 ? `${shown} and ${more} more` : shown,
  };
}

// Replaces events[] with this run's notifications and moves every read
// Shipment's mark. `firstSync`: Connection keys whose discoveries are not new.
// Call at the end of a run, under the state lock. Returns the event count.
export function recordEvents(shipments, { firstSync = new Set() } = {}) {
  const dropped = new Set((shipments.dropped ?? []).map((d) => d.key));
  const found = [];
  for (const s of shipments.shipments) {
    if (!s.lastSeenAt) continue; // never read: nothing to tell yet
    const kind = dropped.has(s.key) ? null : eventKind(s, firstSync);
    if (kind) found.push(EVENTS[kind](s));
    s.notified = mark(s);
  }
  const events = found.length > COLLAPSE_ABOVE ? [summary(found, shipments.shipments)] : found;
  let id = Number.isInteger(shipments.lastEventId) ? shipments.lastEventId : 0;
  shipments.events = events.map((e) => ({ id: ++id, ...e }));
  shipments.lastEventId = id;
  return shipments.events.length;
}
