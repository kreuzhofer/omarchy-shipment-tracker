// A Connection's Health in sources.json (spec #21, "Health"; state machine
// from #19). Each Connection has exactly one Health; a Login in progress is a
// separate field and not touched here.
//
// Success → ok. An auth failure → needs-login with its reason. Any other
// failure is counted with its reason, and makes the Connection source-down at
// once for a changed data format ("shape"), else on the second in a row.
// A network failure only records the run: offline is not an error. The
// offline handling that remains (DHL's empty-list checks, when offline
// counts) belongs to #29.
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
  if (reason === "shape" || connection.failures >= 2 || connection.health === "source-down") {
    enter(connection, "source-down", at);
    connection.message = message;
  }
  connection.reason = reason;
}
