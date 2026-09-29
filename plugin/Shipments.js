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

// ---- Direction tabs and progress cards (#52, variant C of #9)

var tabs = ["Incoming", "Outgoing"]

// "incoming" / "Outgoing" → "Incoming" / "Outgoing"; anything else "".
function tabName(text) {
  var t = String(text || "").toLowerCase()
  return t === "incoming" ? "Incoming" : t === "outgoing" ? "Outgoing" : ""
}

function inTab(s, tab) {
  return (s.direction === "Outgoing" ? "Outgoing" : "Incoming") === tab
}

// The tab label's count: the tab's pending Shipments, i.e. not Terminal and
// not Dismissed (Unknown and mail-only rows count). `shipments` are the ones
// in the 7 / 30 days view, Dismissed included.
function pendingCount(tab, shipments) {
  return shipments.filter(function(s) { return inTab(s, tab) && !terminal[s.status] && !s.dismissed }).length
}

// The tabs a troubled Connection affects: Amazon, and the mailbox that feeds
// it, are Incoming only; DHL lists both Directions.
function connectionTabs(key) {
  return key === "dhl" ? ["Incoming", "Outgoing"] : ["Incoming"]
}

// The tab's dot: "urgent" (a Problem, or a Connection that affects the tab
// needs the user), "accent" (only Ready for pickup) or "" (none). `shipments`
// are the ones that aren't Dismissed, as for the bar icon.
function tabDot(tab, shipments, troubled) {
  var mine = shipments.filter(function(s) { return inTab(s, tab) })
  if (troubled.some(function(t) { return connectionTabs(t.key).indexOf(tab) >= 0 })) return "urgent"
  if (mine.some(function(s) { return s.status === "Problem" })) return "urgent"
  return mine.some(function(s) { return s.status === "Ready for pickup" }) ? "accent" : ""
}

// An Outgoing card is titled with its recipient ("To Anna K."), unless DHL
// named no one and the title fell back to the tracking number.
function cardTitle(s) {
  if (s.direction !== "Outgoing" || !s.title || s.title === s.trackingNumber) return s.title || ""
  return "To " + s.title
}

// The card's 5-step progress bar, as data: { steps, reverse, marker }.
// Announced 1 · In transit 2 · Out for delivery 4 · Delivered 5; Ready for
// pickup 4 with the pickup marker; Problem 3 with the warning marker (the
// step it was on isn't stored); Returning runs backwards from the recipient's
// end, Returned is the full way back; Unknown is empty. shipments.json has no
// hub step yet, so In transit stays at 2.
var PROGRESS = {
  "Announced": { steps: 1 },
  "In transit": { steps: 2 },
  "Out for delivery": { steps: 4 },
  "Ready for pickup": { steps: 4, marker: "pickup" },
  "Problem": { steps: 3, marker: "problem" },
  "Delivered": { steps: 5 },
  "Returning": { steps: 2, reverse: true, marker: "returning" },
  "Returned": { steps: 5, reverse: true },
}
var STEPS = 5

function progress(s) {
  var p = PROGRESS[s.status] || { steps: 0 }
  return { steps: p.steps, reverse: p.reverse === true, marker: p.marker || "" }
}

// Whether segment `index` (0–4) of the bar is filled.
function stepFilled(p, index) {
  return p.reverse ? index >= STEPS - p.steps : index < p.steps
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

// The banner line for a troubled Connection. After a Login that didn't
// succeed, it says so first, until the next Login.
function bannerText(key, c, nowMs) {
  var name = connectionName(key, c)
  if (c.health === "needs-login") {
    var result = loginResultText(c.lastLogin)
    if (result !== "") return result + " · " + name + " still needs a login"
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

// ---- Logins (spec #21, "Login window lifecycle"; the CLI owns the fields)

var STALE_LOGIN_MS = 5 * 6e4

// A Login still in progress: the CLI clears a stale one, but a Login 5 min
// past its deadline never counts, even before that happens.
function loginActive(c, nowMs) {
  return !!c && !!c.login && !!c.login.expiresAt && nowMs - new Date(c.login.expiresAt).getTime() <= STALE_LOGIN_MS
}

function loginResultText(lastLogin) {
  if (!lastLogin) return ""
  if (lastLogin.result === "cancelled") return "Login cancelled"
  if (lastLogin.result === "timed-out") return "Login timed out after 15 min"
  return "Login failed"
}

// The progress banner's line for the Login of `key` (c may still be null
// right after Log in was clicked).
function loginText(key, c, nowMs) {
  var name = connectionName(key, c)
  var login = c && c.login
  if (key === "mail" && (!login || login.phase === "window")) return "Getting a sign-in code for " + name + "…"
  if (!login) return "Opening a Chrome window for " + name + "…"
  if (login.phase === "waiting") return "Waiting for the refresh to finish…"
  if (login.phase === "syncing") return name + " logged in · syncing…"
  var left = minutesLeft(login, nowMs)
  if (login.phase === "code") return "Enter " + login.code + " at " + String(login.url || "").replace(/^https:\/\//, "") + " · " + left + " min left"
  return "Chrome is open · log in to " + name + " there · " + left + " min left"
}

function minutesLeft(login, nowMs) {
  return Math.max(1, Math.ceil((new Date(login.expiresAt).getTime() - nowMs) / 6e4))
}

// The line under the device code on the mail row.
function codeHint(c, nowMs) {
  var login = c && c.login
  if (!login || login.phase !== "code") return ""
  return "Sign in with your work account · " + minutesLeft(login, nowMs) + " min left"
}

// The transient unit a Login runs in (Cancel stops it).
function loginUnit(key) {
  return "shipment-tracker-login-" + systemdEscape(key) + ".service"
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

// ---- The Sources page (#18 variant B, spec #21 "Panel (Sources page)")

// The accordion row's state summary for one Connection (c may be missing:
// never set up). A Login in progress shows as "Connecting…".
function rowSummary(c, loggingIn) {
  if (loggingIn) return "Connecting…"
  if (!c || !c.health || c.health === "not-set-up") return "Not connected"
  if (c.health === "ok") return "Connected"
  if (c.health === "needs-login") return "Needs a login"
  return "Can't be read"
}

// The Amazon row's summary: the account labels, then "1 needs you" or
// "Connecting…"; "Not connected" until one is set up. accounts: [{ key, connection }].
function amazonSummary(accounts, activeKey) {
  var labels = accounts.map(function(a) { return accountLabel(a.key, a.connection) }).join(", ")
  if (accounts.some(function(a) { return a.key === activeKey })) return labels + " · Connecting…"
  // Accounts added but never signed in aren't set up yet.
  if (!accounts.some(function(a) { return isSetUp(a.connection) })) return "Not connected"
  var bad = accounts.filter(function(a) { return isTroubled(a.connection) }).length
  return labels + (bad ? " · " + bad + " need" + (bad === 1 ? "s" : "") + " you" : "")
}

function accountLabel(key, c) {
  return (c && c.label) || String(key).replace(/^amazon:/, "")
}

// Whether a Connection has got past "not set up".
function isSetUp(c) {
  return !!c && !!c.health && c.health !== "not-set-up"
}

// The line a Sources row shows while its Login runs (c may still be null
// right after Log in was clicked).
function rowLoginText(key, c, nowMs) {
  var login = c && c.login
  if (key === "mail" && (!login || login.phase === "window")) return "Getting a sign-in code from Microsoft…"
  if (!login) return "Opening a Chrome window…"
  if (login.phase === "waiting") return "Waiting for the refresh to finish…"
  if (login.phase === "syncing") return (key === "mail" ? "Signed in" : "Logged in") + " · first sync running…"
  var left = minutesLeft(login, nowMs)
  if (login.phase === "code") return codeHint(c, nowMs)
  var text = key === "dhl" ? "Chrome is open on the DHL login. Log in there (2FA too); the window closes by itself."
    : "Chrome is open on amazon.de. Sign in as " + accountLabel(key, c) + " and tick “Angemeldet bleiben”; the window hides itself."
  return text + " · " + left + " min left"
}

// The Health line of a Sources row (empty for a Connection not set up and
// without a Login result). After a Login that didn't succeed it says so.
function rowHealthText(key, c, nowMs) {
  if (isTroubled(c)) return bannerText(key, c, nowMs)
  var result = loginResultText(c && c.lastLogin)
  if (!isSetUp(c)) return result
  // An ok Amazon account says nothing: its check glyph does.
  if (result !== "") return result + " · still connected"
  return key === "dhl" ? "Connected · Incoming and Outgoing" : key === "mail" ? "Connected · read-only mail access" : ""
}

// Falls back to ASCII letters where the JS engine lacks Unicode property escapes.
function labelPattern() {
  try {
    return new RegExp("^[\\p{L}\\p{N}][\\p{L}\\p{N} _-]{0,23}$", "u")
  } catch (e) {
    return /^[A-Za-z0-9\u00C0-\u024F][A-Za-z0-9\u00C0-\u024F _-]{0,23}$/
  }
}

// Mirrors the CLI's label rule (amazon/connection.mjs): 1–24 letters,
// digits, spaces, - or _, starting with a letter or digit.
function labelProblem(label, accounts) {
  var text = String(label || "").trim()
  if (text === "") return "required"
  if (!labelPattern().test(text)) return "A label is 1–24 letters, digits, spaces, - or _"
  var lower = text.toLowerCase()
  if (accounts.some(function(a) { return accountLabel(a.key, a.connection).toLowerCase() === lower }))
    return "An account with this label exists"
  return ""
}

// The state glyph of a Connection on the Sources page (login: its Login
// record while one runs, else null).
function connectionGlyph(c, loggingIn) {
  if (loggingIn) return c && c.login && c.login.phase === "syncing" ? "\u{F04E6}" : "\u{F059F}" // sync / web
  if (!isSetUp(c)) return "\u{F0766}"                      // circle-outline
  if (c.health === "ok") return "\u{F05E0}"                // check-circle
  if (c.health === "needs-login") return "\u{F033E}"       // lock
  return "\u{F0164}"                                       // cloud-off-outline
}

// "good", "bad" (the user must look) or "" (muted), for the glyph's colour.
function connectionTone(c, loggingIn) {
  if (loggingIn) return "busy"
  if (isTroubled(c)) return "bad"
  return isSetUp(c) ? "good" : ""
}
