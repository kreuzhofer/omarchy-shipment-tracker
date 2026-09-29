// Desktop notifications from the CLI's events[] (spec #21, "Notifications").
// A library, so its state is shared by every Store in the shell: the bar (and
// with it the Store) exists once per screen, and only one of them may claim an
// event.
.pragma library
.import "Shipments.js" as Shipments

// The highest event id already handled; -1 until shipments.json was first read.
var handled = -1

// The events of `state` (parsed shipments.json) that are new to this shell.
// The first read only records the highest id, so a shell (re)start replays
// nothing; a lower id than handled means the file was reset: start over from
// it, again without notifying. `state` null means there is no file yet, so the
// first run's events count.
function claim(state) {
  if (!state) {
    if (handled < 0) handled = 0
    return []
  }
  var events = (state.events || []).filter(function(e) { return e && typeof e.id === "number" })
  var top = Number(state.lastEventId) || 0
  events.forEach(function(e) { if (e.id > top) top = e.id })
  if (handled < 0 || top < handled) {
    handled = top
    return []
  }
  var fresh = events.filter(function(e) { return e.id > handled })
  handled = top
  return fresh
}

// The command for one notification, through Omarchy's own sender so a click
// still works after a shell restart (the action rides along as an argv). A
// Shipment's opens its page; a summary or connection event (no url) opens the popup.
function command(e, omarchyBin) {
  var glyph = e.kind === "summary" ? "\u{F03D7}" : e.kind === "connection" ? "\u{F033E}" : Shipments.statusGlyph(e.status)
  var argv = [omarchyBin + "omarchy-notification-send", "--app-name", "Shipment tracker", "-u", "normal", "-g", glyph,
    String(e.title || "Shipments"), String(e.body || "")]
  if (e.url) return argv.concat(["--exec", "xdg-open", String(e.url)])
  return argv.concat(["--exec", omarchyBin + "omarchy-shell", "kreuzhofer.shipment-tracker", "show"])
}
