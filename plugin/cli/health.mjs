// A Connection's Health in sources.json (spec #21, "Health"). This covers the
// transitions a sync needs today: success → ok, an auth failure → needs-login
// with its reason, any other failure counted with its reason. The rest of the
// state machine (source-down after 2 failures or 1 shape failure, offline
// handling, the DHL empty-list checks) belongs to #29.
const AUTH_REASONS = new Set(["expired", "account-link-lost", "empty-list", "challenge", "signed-out"]);

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

// A network failure changes nothing here: offline is not an error (#29 decides
// when it counts).
export function recordFailure(connection, now, reason) {
  const at = now.toISOString();
  connection.lastRun = at;
  if (reason === "network") return;
  if (AUTH_REASONS.has(reason)) {
    enter(connection, "needs-login", at);
    connection.reason = reason;
    return;
  }
  connection.failures += 1;
  connection.reason = reason;
}
