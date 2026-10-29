// Design study #90 (throwaway): one popup frame of a variant, rendered
// offscreen with synthetic data. render.sh copies this next to the variant's
// QML, so ShipmentList / SourcesPage / Store resolve to the variant's files.
//
// SCENE (env):
//   fresh-list     a fresh install: nothing connected, nothing tracked
//   fresh-sources  the same, Sources page (DHL row opens by itself)
//   off-list       DHL + Amazon connected, background refresh off
//   off-sources    the same, Sources page, all rows closed
//   login-done     the DHL row right after its first Login finished (variant C)
//   on-sources     background refresh on, Sources page
//   on-list        background refresh on, list
import QtQuick
import Quickshell
import qs.Commons
import qs.Ui

Rectangle {
  id: card
  readonly property string scene: Quickshell.env("SCENE")
  readonly property int pad: Style.spacing.popupPadding
  readonly property bool sourcesPage: scene.indexOf("sources") >= 0 || scene === "login-done"
  width: Style.space(470) + pad * 2 + 2
  height: (sourcesPage ? sources.implicitHeight : list.implicitHeight) + pad * 2 + 2
  color: Color.popups.background
  border.color: Color.popups.border
  border.width: 1

  // Fake host: notifications on, like a default install.
  QtObject { id: host; property bool notificationsOn: true; function setNotifications(v) { notificationsOn = v } }
  Store { id: store; host: host }

  function iso(minutesAgo) { return new Date(Date.now() - minutesAgo * 60000).toISOString() }
  function day(offset) { var d = new Date(Date.now() + offset * 864e5); return d.toISOString().substring(0, 10) }

  function connected() {
    return {
      dhl: { health: "ok", lastSuccess: iso(12) },
      "amazon:Personal": { health: "ok", label: "Personal", lastSuccess: iso(12) },
      mail: { health: "not-set-up" },
    }
  }
  function shipments() {
    function s(key, src, title, status, from, to, text, ago, extra) {
      return Object.assign({ key: key, direction: "Incoming", source: src, carrier: src === "Amazon" ? "Amazon Logistics" : src,
        title: title, status: status, estimate: from ? { from: from, to: to, text: text } : null, changedAt: iso(ago) }, extra || {})
    }
    return [
      s("dhl:00340434161094042557", "DHL", "Coffee grinder", "Out for delivery", day(0), day(0), "Today 14:00–17:00", 70),
      s("amazon:302-0000000-0000001#0", "Amazon", "USB-C cable, 2 m", "In transit", day(1), day(1), "Tomorrow", 300, { account: "Personal" }),
      s("dhl:00340434161094042558", "DHL", "Winter boots", "In transit", day(2), day(3), "", 1500),
      s("dhl:00340434161094042559", "DHL", "Book parcel", "Delivered", day(-2), day(-2), "Delivered", 2 * 1440, { terminalAt: iso(2 * 1440) }),
    ]
  }

  function setUp() {
    var on = card.scene.indexOf("on-") === 0
    if (card.scene.indexOf("fresh") === 0) {
      store.sourcesState = { lastRun: null, refreshing: null, offline: false, connections: {} }
      store.shipmentsState = { shipments: [], events: [] }
    } else if (card.scene === "login-done") {
      var c = connected()
      c.dhl = { health: "ok", lastSuccess: iso(0.5), loggedInAt: iso(0.5) }
      delete c["amazon:Personal"]
      store.sourcesState = { lastRun: iso(0.5), refreshing: null, offline: false, connections: c }
      store.shipmentsState = { shipments: shipments().filter(function(x) { return x.source === "DHL" }), events: [] }
    } else {
      store.sourcesState = { lastRun: iso(3), refreshing: null, offline: false, connections: connected() }
      store.shipmentsState = { shipments: shipments(), events: [] }
    }
    store.timerInstalled = on
    store.nowMs = Date.now()
    store.nodeOk = true
    if (card.scene === "fresh-sources") store.setPage("sources")
    else if (card.scene === "login-done") store.setPage("sources:dhl")
    else if (card.sourcesPage) store.setPage("sources:none")
    else store.setPage("list")
  }

  ShipmentList {
    id: list
    visible: !card.sourcesPage
    x: card.pad + 1; y: card.pad + 1
    width: Style.space(470)
    store: store
    fg: Color.foreground
  }
  SourcesPage {
    id: sources
    visible: card.sourcesPage
    x: card.pad + 1; y: card.pad + 1
    width: Style.space(470)
    store: store
    fg: Color.foreground
  }

  // The FileViews find no state (empty XDG_STATE_HOME) and reset; then the
  // synthetic data goes in, and the frame is grabbed once it has settled.
  Timer { interval: 400; running: true; onTriggered: card.setUp() }
  Timer {
    interval: 1600; running: true
    onTriggered: card.grabToImage(function(r) { r.saveToFile(Quickshell.env("OUT")); Qt.quit() })
  }
}
