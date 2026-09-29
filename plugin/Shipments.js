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

function age(iso, nowMs) {
  if (!iso) return ""
  var h = (nowMs - new Date(iso).getTime()) / 36e5
  if (h < 1 / 60) return "just now"
  if (h < 1) return Math.round(h * 60) + " min ago"
  if (h < 24) return Math.round(h) + " h ago"
  return Math.round(h / 24) + " d ago"
}

// "DHL", "Amazon · Personal", "Amazon · Personal via DHL"
function sourceLabel(s) {
  var label = s.source + (s.account ? " · " + s.account : "")
  if (s.carrier && s.carrier !== s.source) label += " via " + s.carrier
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
