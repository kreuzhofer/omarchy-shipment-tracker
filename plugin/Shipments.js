// Presentation helpers for Shipment rows. Terms follow CONTEXT.md.
.pragma library

// Nerd Font Material Design glyphs, one per Status (spec #21, "QML plugin").
function statusGlyph(status) {
  switch (status) {
    case "Announced": return "\u{F03D7}"        // box
    case "In transit": return "\u{F053D}"       // truck
    case "Out for delivery": return "\u{F0788}" // truck-fast
    case "Ready for pickup": return "\u{F06EE}" // mailbox
    case "Problem": return "\u{F0026}"          // alert
    case "Returning": return "\u{F054D}"        // undo-variant
    case "Returned": return "\u{F054C}"         // undo
    case "Delivered": return "\u{F012C}"        // check
  }
  return "\u{F0625}"                            // help-circle-outline (Unknown)
}

var terminal = { "Delivered": true, "Returned": true }
// "Needs you": the user has to act (collect, fix).
var attention = { "Ready for pickup": true, "Problem": true }
// Urgency groups (spec #21): what needs the user, then in flight, then Terminal.
var rank = { "Problem": 0, "Ready for pickup": 1, "Out for delivery": 2, "In transit": 3, "Returning": 3,
  "Announced": 4, "Unknown": 5, "Delivered": 6, "Returned": 6 }

// Urgency first, newest change first within a group.
function byUrgency(a, b) {
  var ra = rank[a.status] !== undefined ? rank[a.status] : 5
  var rb = rank[b.status] !== undefined ? rank[b.status] : 5
  return (ra - rb) || String(b.changedAt || "").localeCompare(String(a.changedAt || ""))
}

function localDay(ms) {
  var d = new Date(ms)
  function pad(n) { return (n < 10 ? "0" : "") + n }
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
}

// A delivery window that lies entirely on one day, as "yyyy-MM-dd", else "".
function windowDay(s) {
  var e = s.estimate
  if (!e || !e.from || !e.to || terminal[s.status] || attention[s.status]) return ""
  var from = String(e.from).slice(0, 10)
  return from === String(e.to).slice(0, 10) ? from : ""
}

function arrivingToday(s, nowMs) {
  return s.status === "Out for delivery" || (windowDay(s) !== "" && windowDay(s) === localDay(nowMs))
}

// The Estimate as the row shows it: the CLI writes absolute days ("Wed 30 Sep"),
// the row says "Today" or "Tomorrow" for a one-day window.
function estimateText(s, nowMs) {
  if (!s.estimate) return ""
  var text = s.estimate.text || ""
  var day = windowDay(s)
  if (day === "") return text
  var label = day === localDay(nowMs) ? "Today" : day === localDay(nowMs + 864e5) ? "Tomorrow" : ""
  return label ? text.replace(/^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}/, label) : text
}

// "2 need you · 1 arriving today · " (empty parts left out).
function summary(shipments, troubledCount, nowMs) {
  var need = troubledCount, today = 0
  shipments.forEach(function(s) {
    if (attention[s.status]) need++
    if (arrivingToday(s, nowMs)) today++
  })
  return (need ? need + " need you · " : "") + (today ? today + " arriving today · " : "")
}

function age(iso, nowMs) {
  if (!iso) return ""
  var h = (nowMs - new Date(iso).getTime()) / 36e5
  if (h < 1 / 60) return "just now"
  if (h < 1) return Math.round(h * 60) + " min ago"
  if (h < 24) return Math.round(h) + " h ago"
  return Math.round(h / 24) + " d ago"
}

// "DHL", "Amazon · Personal", "Amazon · Personal via DHL". Amazon Logistics
// is Amazon's own Carrier, so it gets no "via".
function sourceLabel(s) {
  var label = s.source + (s.account ? " · " + s.account : "")
  if (s.carrier && s.carrier !== s.source && s.carrier.indexOf(s.source + " ") !== 0) label += " via " + s.carrier
  return label
}

// What the add field would become as a DHL tracking number (mirrors the CLI's
// parseManualId, for the immediate "Looking up…" row only).
function normalizeTrackingNumber(text) {
  return String(text || "").replace(/\s+/g, "").toUpperCase()
}

function dhlTrackingUrl(trackingNumber) {
  return "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=" + encodeURIComponent(trackingNumber)
}
