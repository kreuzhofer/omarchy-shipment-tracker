// A Connection's Health in sources.json (spec #21, "Health"; state machine
// from #19). Each Connection has exactly one Health; a Login in progress is a
// separate field and not touched here.
//
// Success → ok. An auth failure → needs-login with its reason. Any other
// failure is counted with its reason, and makes the Connection source-down at
// once for a changed data format ("shape"), else on the second in a row.
// A network failure only records the run unless the caller says it counts:
// offline is not an error. A needs-login Connection stays needs-login until a
// success or a Login; other failures on the way only count.
//
// A `connection` notification event is recorded once on entering
// needs-login, and again only after the Connection was ok in between
// (recordConnectionEvents). source-down never notifies: the user can't fix it.
export const AUTH_REASONS = new Set(["expired", "account-link-lost", "empty-list", "challenge", "signed-out"]);

export function connectionRecord(sources, key) {
  sources.connections[key] ??= {
    health: "not-set-up",
    reason: null,
    since: null,
    lastRun: null,
    lastOk: null,
    failures: 0,
    message: null,
    lastCount: null,
    login: null,
    lastLogin: null,
  };
  return sources.connections[key];
}

function enter(connection, health, at) {
  if (connection.health !== health) connection.since = at;
  connection.health = health;
}

export function recordOk(connection, now, count) {
  const at = now.toISOString();
  enter(connection, "ok", at);
  connection.reason = null;
  connection.message = null;
  connection.failures = 0;
  connection.lastRun = at;
  connection.lastOk = at;
  connection.lastCount = count;
}

// `message` is the banner text for the reason, if the Connection has one.
// `countNetwork`: the caller has seen something else in this run get
// through, so a network failure is this Connection's own and counts.
export function recordFailure(connection, now, reason, { message = null, countNetwork = false } = {}) {
  const at = now.toISOString();
  connection.lastRun = at;
  if (reason === "network" && !countNetwork) return;
  if (AUTH_REASONS.has(reason)) {
    enter(connection, "needs-login", at);
    connection.reason = reason;
    connection.message = message;
    return;
  }
  connection.failures += 1;
  // The login is still what the user has to fix; its reason drives the copy.
  if (connection.health === "needs-login") return;
  if (reason === "shape" || connection.failures >= 2 || connection.health === "source-down") {
    enter(connection, "source-down", at);
    connection.message = message;
  }
  connection.reason = reason;
}

// How banners and notifications name a Connection.
export function connectionName(key, connection) {
  if (key === "dhl") return "DHL";
  if (key === "mail") return "Microsoft 365 mail";
  if (key.startsWith("amazon:")) return `Amazon · ${connection?.label ?? key.slice("amazon:".length)}`;
  return key;
}

const LOGIN_BODIES = {
  "empty-list": () => "DHL returned no Shipments, which usually means the login was lost",
  challenge: (name) => `${name} asks for a security check`,
};
const loginBody = (name, reason) => LOGIN_BODIES[reason]?.(name) ?? "The list may be incomplete until you log in again";

// Appends a `connection` event for every Connection that entered needs-login
// since it was last announced; ids continue from lastEventId. A Connection
// remembers the `since` it was announced for, and `since` only changes when
// its Health does, so staying in needs-login stays quiet and a new entry
// (after an ok) is announced again. The event has no url: a click opens the
// popup. Call after recordEvents, under the state lock. Returns the count.
export function recordConnectionEvents(shipments, sources) {
  let id = Number.isInteger(shipments.lastEventId) ? shipments.lastEventId : 0;
  shipments.events ??= [];
  let count = 0;
  for (const [key, c] of Object.entries(sources.connections ?? {})) {
    if (c?.health !== "needs-login" || c.notifiedSince === c.since) continue;
    c.notifiedSince = c.since;
    const name = connectionName(key, c);
    shipments.events.push({
      id: ++id, kind: "connection", connection: key, health: c.health, reason: c.reason,
      title: `${name} needs a login`, body: loginBody(name, c.reason),
    });
    count++;
  }
  shipments.lastEventId = id;
  return count;
}
