// PROTOTYPE fake Shipments for the popup (#9) and onboarding (#18) variants. Covers every Status
// in CONTEXT.md, both Directions, all Sources, and the 7- vs 30-day window.
.pragma library

function daysAgo(n) { return new Date(Date.now() - n * 864e5).toISOString() }

var shipments = [
  { id: "a1", direction: "Incoming", source: "Amazon", account: "Business", carrier: "Amazon Logistics", title: "USB-C Dock", status: "Out for delivery", step: 4, estimate: "Today 14–17", delayed: false, changed: daysAgo(0.05), url: "https://www.amazon.de/gp/your-account/order-details" },
  { id: "d1", direction: "Incoming", source: "DHL", account: "", carrier: "DHL", title: "Vanilla Shop", status: "Ready for pickup", step: 4, estimate: "Packstation 142 · until Fri", delayed: false, changed: daysAgo(0.3), url: "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html" },
  { id: "d2", direction: "Incoming", source: "DHL", account: "", carrier: "DHL", title: "Coffee roastery", status: "Problem", step: 3, estimate: "Delivery attempt failed", delayed: false, changed: daysAgo(0.8), url: "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html" },
  { id: "a2", direction: "Incoming", source: "Amazon", account: "Personal", carrier: "DHL", title: "Winter boots", status: "In transit", step: 2, estimate: "Thu 2 Oct", delayed: true, changed: daysAgo(1), url: "https://www.amazon.de/gp/your-account/order-details" },
  { id: "o1", direction: "Outgoing", source: "DHL", account: "", carrier: "DHL", title: "To: Max M. (return drill)", status: "In transit", step: 3, estimate: "Wed 1 Oct", delayed: false, changed: daysAgo(1.2), url: "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html" },
  { id: "d3", direction: "Incoming", source: "DHL", account: "", carrier: "DHL", title: "Pharmacy", status: "Announced", step: 1, estimate: "", delayed: false, changed: daysAgo(1.5), url: "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html" },
  { id: "o3", direction: "Outgoing", source: "DHL", account: "", carrier: "DHL", title: "To: Kleinanzeigen buyer", status: "Returning", step: 3, estimate: "Back to you Fri", delayed: false, changed: daysAgo(2.5), url: "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html" },
  { id: "d6", direction: "Incoming", source: "DHL", account: "", carrier: "DHL", title: "JJD000390007712345", status: "Unknown", step: 0, estimate: "Not known to DHL yet", delayed: false, changed: daysAgo(0.6), url: "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html" },
  { id: "a3", direction: "Incoming", source: "Amazon", account: "Personal", carrier: "Amazon Logistics", title: "Tupperware set", status: "Delivered", step: 5, estimate: "Delivered Mon 29 Sep", delayed: false, changed: daysAgo(2), url: "https://www.amazon.de/gp/your-account/order-details" },
  { id: "o2", direction: "Outgoing", source: "DHL", account: "", carrier: "DHL", title: "To: Anna K.", status: "Delivered", step: 5, estimate: "Delivered Sat 27 Sep", delayed: false, changed: daysAgo(4), url: "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html" },
  { id: "d4", direction: "Incoming", source: "DHL", account: "", carrier: "DHL", title: "Shoe shop", status: "Delivered", step: 5, estimate: "Delivered 17 Sep", delayed: false, changed: daysAgo(12), url: "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html" },
  { id: "a4", direction: "Incoming", source: "Amazon", account: "Business", carrier: "DHL", title: "Robot arm kit", status: "Returned", step: 5, estimate: "Refund issued", delayed: false, changed: daysAgo(20), url: "https://www.amazon.de/gp/your-account/order-details" },
  { id: "d5", direction: "Incoming", source: "DHL", account: "", carrier: "DHL", title: "Softdrinks", status: "Delivered", step: 5, estimate: "Delivered 3 Sep", delayed: false, changed: daysAgo(26), url: "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html" }
]

var terminal = { "Delivered": true, "Returned": true }
// "Needs you": the user has to act (collect, fix). Drives the bar icon's active state.
var attention = { "Ready for pickup": true, "Problem": true }

// Urgency first (needs the user), then in-flight, then Terminal; newest first within.
var rank = { "Problem": 0, "Ready for pickup": 1, "Out for delivery": 2, "In transit": 3, "Returning": 3, "Announced": 4, "Unknown": 5, "Delivered": 6, "Returned": 6 }

function visible(days) {
  var cutoff = Date.now() - days * 864e5
  return shipments.filter(function(s) { return new Date(s.changed).getTime() >= cutoff })
    .sort(function(a, b) { return (rank[a.status] - rank[b.status]) || (new Date(b.changed) - new Date(a.changed)) })
}

function age(iso) {
  var h = (Date.now() - new Date(iso).getTime()) / 36e5
  if (h < 1 / 60) return "just now"
  if (h < 1) return Math.round(h * 60) + " min ago"
  if (h < 24) return Math.round(h) + " h ago"
  return Math.round(h / 24) + " d ago"
}

// Nerd Font Material Design glyphs (checked against JetBrainsMono Nerd Font).
function statusGlyph(status) {
  switch (status) {
    case "Announced": return "\u{F03D7}"        // box
    case "In transit": return "\u{F053D}"       // truck
    case "Out for delivery": return "\u{F0788}" // truck-fast
    case "Ready for pickup": return "\u{F06EE}" // mailbox
    case "Problem": return "\u{F0026}"          // alert
    case "Returning": return "\u{F054D}"        // undo-variant
    case "Delivered": return "\u{F012C}"        // check
    case "Returned": return "\u{F054C}"         // undo
  }
  return "\u{F0625}"                            // help-circle-outline (Unknown)
}

// Per-Source health, as sources.json would carry it (#12). One Amazon account
// needs a login so the variants can show the needs-login state.
var sources = [
  { key: "dhl", source: "DHL", account: "", state: "ok" },
  { key: "amazon-personal", source: "Amazon", account: "Personal", state: "ok" },
  { key: "amazon-business", source: "Amazon", account: "Business", state: "needs-login", loginUrl: "https://www.amazon.de/ap/signin" }
]
var lastRefresh = new Date(Date.now() - 12 * 6e4).toISOString()

function troubled() { return sources.filter(function(s) { return s.state !== "ok" }) }

// Onboarding (#18): only Shipments from connected Sources are visible. Fake
// Amazon rows tagged "Personal" belong to the 1st connected account, "Business"
// to the 2nd, and are shown under whatever label the user gave that account.
function forSources(days, dhlOn, accountLabels) {
  var slot = { "Personal": 0, "Business": 1 }
  var out = []
  visible(days).forEach(function(s) {
    if (s.source === "DHL") { if (dhlOn) out.push(s); return }
    var label = accountLabels[slot[s.account]]
    if (!label) return
    var copy = {}
    for (var k in s) copy[k] = s[k]
    copy.account = label
    out.push(copy)
  })
  return out
}

function sorted(list) {
  return list.slice().sort(function(a, b) { return (rank[a.status] - rank[b.status]) || (new Date(b.changed) - new Date(a.changed)) })
}

// A manually added Shipment starts as Unknown until the first lookup.
// Without an Amazon account that owns the Order it stays link-only (#10).
function manual(id, amazonAccount) {
  var amazon = /^\d{3}-\d{7}-\d{7}$/.test(id)
  return { id: "m-" + id, direction: "Incoming", source: amazon ? "Amazon" : "DHL", account: amazon ? (amazonAccount || "") : "", carrier: amazon ? "" : "DHL",
    title: (amazon ? "Order " : "") + id, status: "Unknown", step: 0, estimate: amazon && !amazonAccount ? "Link only · no Amazon account" : "Looking up…", delayed: false, changed: new Date().toISOString(),
    url: amazon ? "https://www.amazon.de/gp/your-account/order-details?orderID=" + id : "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=" + id }
}

function sourceLabel(s) {
  var label = s.source + (s.account ? " · " + s.account : "")
  if (s.carrier && s.carrier !== s.source) label += " via " + s.carrier
  return label
}
