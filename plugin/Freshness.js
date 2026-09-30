// When the plugin starts a refresh by itself (#79). The hourly timer's
// catch-up run after a resume can start before the network is up; the CLI
// then waits for it, but the plugin also refreshes a stale list when the
// popup opens, and once shortly after a resume. Pure functions, tested in
// test/plugin-freshness.test.mjs.
.pragma library

var MINUTE = 60000
// The last run that got through is older than this: the hourly timer missed
// at least one run.
var STALE_MS = 65 * MINUTE
// Never more than one automatic refresh in this time.
var THROTTLE_MS = 5 * MINUTE
// A tick that comes this much later than expected means the machine slept.
var JUMP_MS = 10 * MINUTE
// After a resume, give the network this long before checking.
var WAKE_DELAY_MS = 30000

// Whether the list is stale: the last run was offline, or the last run that
// got through (sources.lastOnline) is more than 65 minutes old.
function stale(sources, nowMs) {
  if (!sources) return true
  if (sources.offline === true) return true
  var last = Date.parse(sources.lastOnline || sources.lastRun || "")
  return isNaN(last) || nowMs - last > STALE_MS
}

// Whether to start a refresh now: the list is stale, no refresh runs, and the
// last automatic one is more than 5 minutes ago (lastAutoMs 0: none yet).
function shouldRefresh(sources, nowMs, lastAutoMs, refreshing) {
  if (refreshing) return false
  if (lastAutoMs > 0 && nowMs - lastAutoMs < THROTTLE_MS) return false
  return stale(sources, nowMs)
}

// Whether the wall clock jumped between two ticks `intervalMs` apart by more
// than 10 minutes: the machine was suspended in between.
function wokeUp(lastTickMs, nowMs, intervalMs) {
  if (!(lastTickMs > 0)) return false
  return nowMs - lastTickMs - intervalMs > JUMP_MS
}
