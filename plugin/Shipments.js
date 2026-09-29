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

// The add field's format decides the Source, as in the CLI's parseManualId:
// an Amazon Order ID (NNN-NNNNNNN-NNNNNNN), else a DHL tracking number.
function isAmazonOrderId(id) {
  return /^\d{3}-\d{7}-\d{7}$/.test(String(id || ""))
}

// The key `add` will write for a normalized ID.
function manualKey(id) {
  return (isAmazonOrderId(id) ? "amazon:" : "dhl:") + id
}

// The immediate "Looking up…" row for an ID `add` hasn't written yet.
function queuedRow(id, at) {
  var amazon = isAmazonOrderId(id)
  return { key: "queued:" + id, direction: "Incoming", source: amazon ? "Amazon" : "DHL", account: null,
    carrier: amazon ? null : "DHL", title: id, status: "Unknown", estimate: { text: "Looking up…" }, delayed: false,
    url: amazon ? amazonOrderUrl(id) : dhlTrackingUrl(id), changedAt: at, discoveredAt: at }
}

function amazonOrderUrl(orderId) {
  return "https://www.amazon.de/your-orders/order-details?orderID=" + encodeURIComponent(orderId)
}

function dhlTrackingUrl(trackingNumber) {
  return "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=" + encodeURIComponent(trackingNumber)
}

// ---- Connections and their Health (spec #21, "Health"; copy from #19)

// "DHL", "Amazon · Business", "Microsoft 365 mail" (as the CLI's notifications name them).
function connectionName(key, c) {
  if (key === "dhl") return "DHL"
  if (key === "mail") return "Microsoft 365 mail"
  if (String(key).indexOf("amazon:") === 0) return "Amazon · " + ((c && c.label) || String(key).slice(7))
  return String(key)
}

// Only the Source for "… changed its data format": the format is Amazon's, not the account's.
function sourceName(key) {
  return key === "dhl" ? "DHL" : key === "mail" ? "Microsoft 365 mail" : "Amazon"
}

function isTroubled(c) {
  return !!c && (c.health === "needs-login" || c.health === "source-down")
}

// DHL, then the Amazon accounts, then mail.
function connectionOrder(a, b) {
  function rankOf(k) { return k === "dhl" ? 0 : k === "mail" ? 2 : 1 }
  return (rankOf(a) - rankOf(b)) || String(a).localeCompare(String(b))
}

var weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

// "14:00" today, else "Mon 14:00" (local time).
function clockText(iso, nowMs) {
  if (!iso) return ""
  var d = new Date(iso)
  function pad(n) { return (n < 10 ? "0" : "") + n }
  var time = pad(d.getHours()) + ":" + pad(d.getMinutes())
  return localDay(d.getTime()) === localDay(nowMs) ? time : weekdays[d.getDay()] + " " + time
}

// The banner line for a troubled Connection.
function bannerText(key, c, nowMs) {
  var name = connectionName(key, c)
  if (c.health === "needs-login") {
    if (c.reason === "challenge") return name + " asks for a security check"
    if (c.reason === "empty-list") return "DHL returned no Shipments, which usually means the login was lost"
    return name + " needs a login · list may be incomplete"
  }
  if (c.reason === "shape") return sourceName(key) + " changed its data format · an update of the tracker is needed"
  return name + " can't be read since " + clockText(c.since, nowMs) + " · showing what was last seen"
}

// The banner's button: Log in, Open (a security check) or Retry.
function bannerAction(c) {
  if (c.health === "source-down") return "Retry"
  return c.reason === "challenge" ? "Open" : "Log in"
}

// The bar tooltip: "2 need you · 1 arriving today", "Shipments", or
// "Shipments · not set up" before any Source or Shipment.
function tooltip(shipments, troubledCount, nowMs, setUp) {
  if (!setUp && shipments.length === 0) return "Shipments · not set up"
  var text = summary(shipments, troubledCount, nowMs).replace(/ · $/, "")
  return text !== "" ? text : "Shipments"
}

// Whether the bar icon is active: a Shipment is Ready for pickup or has a
// Problem, or a Connection needs a login or can't be read.
function needsYou(shipments, troubledCount) {
  return troubledCount > 0 || shipments.some(function(s) { return attention[s.status] === true })
}

// systemd-escape for a unit instance name: [A-Za-z0-9:_.] stay (no leading
// "."), "/" becomes "-", every other byte \xNN (UTF-8).
function systemdEscape(text) {
  var out = ""
  var chars = Array.from(String(text))
  for (var i = 0; i < chars.length; i++) {
    var ch = chars[i]
    if (/^[A-Za-z0-9:_]$/.test(ch) || (ch === "." && i > 0)) out += ch
    else if (ch === "/") out += "-"
    else {
      var encoded = encodeURIComponent(ch)
      if (encoded.charAt(0) === "%") out += encoded.replace(/%([0-9A-F]{2})/g, function(m, h) { return "\\x" + h.toLowerCase() })
      else out += "\\x" + ch.charCodeAt(0).toString(16)
    }
  }
  return out
}
