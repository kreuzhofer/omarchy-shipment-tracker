// The plugin's view of the backend. The shipment-tracker CLI owns all data;
// this only watches its two state files, starts CLI commands and the refresh
// service, and keeps the not-yet-written manual adds for immediate feedback.
// It also turns the CLI's notification events into desktop notifications.
import QtQuick
import Quickshell
import Quickshell.Io
import "Shipments.js" as Shipments
import "Notify.js" as Notify

Item {
  id: root

  readonly property string stateDir: (Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state")) + "/omarchy-shipment-tracker"
  readonly property string cliPath: decodeURIComponent(String(Qt.resolvedUrl("cli/shipment-tracker.mjs")).replace(/^file:\/\//, ""))
  readonly property string refreshUnit: "shipment-tracker-refresh.service"

  property var shipmentsState: ({ shipments: [], events: [] })
  property var sourcesState: ({ lastRun: null, refreshing: null, offline: false, connections: {} })
  // Manual adds typed in the popup that `add` hasn't written yet: [{ id, text, at, running }].
  property var queuedAdds: []
  property string addError: ""
  // Keys `remove` is taking out, in the order clicked; hidden at once.
  property var pendingRemovals: []
  // Removed keys stay hidden until shipments.json no longer lists them as manual
  // adds, so the row doesn't flash back before the file is re-read.
  property var removedKeys: []
  property double nowMs: Date.now()
  // The bar widget, which owns the notifications setting.
  property var host: null
  readonly property bool notificationsOn: host ? host.notificationsOn === true : true
  readonly property string omarchyBin: Quickshell.env("OMARCHY_PATH") ? Quickshell.env("OMARCHY_PATH") + "/bin/" : ""

  // The header's 7 / 30 days switch: the list shows Shipments whose last change
  // falls in the last `days` days (retention keeps at most 30).
  property int days: 7
  readonly property string lastRun: sourcesState.lastRun || ""
  readonly property var shipments: {
    var known = {}
    var gone = {}
    pendingRemovals.concat(removedKeys).forEach(function(k) { gone[k] = true })
    var rows = (shipmentsState.shipments || []).filter(function(s) { return !gone[s.key] })
    // A merged Amazon Shipment (#27) also stands for its DHL tracking number.
    rows.forEach(function(s) {
      known[s.key] = true
      if (s.trackingNumber) known["dhl:" + s.trackingNumber] = true
    })
    var queued = queuedAdds.filter(function(p) { return !known[Shipments.manualKey(p.id)] }).map(function(p) {
      return Shipments.queuedRow(p.id, p.at)
    })
    return queued.concat(rows).sort(Shipments.byUrgency)
  }
  // What the list shows: `shipments` within the 7 / 30 days window. Manual adds
  // waiting for `add` always show.
  readonly property var recentShipments: {
    var cutoff = nowMs - days * 864e5
    return shipments.filter(function(s) {
      return String(s.key).indexOf("queued:") === 0 || new Date(s.changedAt).getTime() >= cutoff
    })
  }
  // Nothing tracked and no Connection set up: the first-run empty state.
  readonly property bool nothingTracked: (shipmentsState.shipments || []).length === 0 && queuedAdds.length === 0
    && Object.keys(sourcesState.connections || {}).every(function(k) {
      var c = sourcesState.connections[k]
      return !c || c.health === "not-set-up"
    })

  function setDays(n) {
    if (n === 7 || n === 30) root.days = n
  }

  // Connections the user must fix or that can't be read; they count as "need you".
  readonly property int troubledCount: {
    var c = sourcesState.connections || {}
    return Object.keys(c).filter(function(k) { return c[k] && (c[k].health === "needs-login" || c[k].health === "source-down") }).length
  }
  // A run that died without clearing `refreshing` stops counting after 15 min.
  readonly property bool refreshing: !!sourcesState.refreshing && !!sourcesState.refreshing.startedAt
    && nowMs - new Date(sourcesState.refreshing.startedAt).getTime() < 15 * 6e4
  readonly property string summary: Shipments.summary(shipments, troubledCount, nowMs)

  function parse(text, fallback) {
    try {
      var parsed = JSON.parse(String(text || ""))
      return parsed && typeof parsed === "object" ? parsed : fallback
    } catch (e) {
      return fallback
    }
  }

  FileView {
    id: shipmentsFile
    path: root.stateDir + "/shipments.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      root.shipmentsState = root.parse(text(), root.shipmentsState)
      root.handleEvents(root.shipmentsState)
      var listed = {}
      var rows = root.shipmentsState.shipments || []
      rows.forEach(function(s) { listed[s.key] = (s.connections || []).indexOf("manual") >= 0 })
      if (root.removedKeys.length) root.removedKeys = root.removedKeys.filter(function(k) { return listed[k] })
    }
    onLoadFailed: {
      root.shipmentsState = ({ shipments: [], events: [] })
      root.handleEvents(null)
    }
  }

  FileView {
    id: sourcesFile
    path: root.stateDir + "/sources.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.sourcesState = root.parse(text(), root.sourcesState)
    onLoadFailed: root.sourcesState = ({ lastRun: null, refreshing: null, offline: false, connections: {} })
  }

  function toggleNotifications() {
    if (root.host && typeof root.host.setNotifications === "function") root.host.setNotifications(!root.notificationsOn)
  }

  // events[] holds the notifications of the CLI's last run, already filtered
  // and collapsed (spec #21); the plugin only gates them on the toggle and the
  // last handled id (see Notify.js).
  function handleEvents(state) {
    var fresh = Notify.claim(state)
    if (!root.notificationsOn) return
    fresh.forEach(function(e) { Quickshell.execDetached(Notify.command(e, root.omarchyBin)) })
  }

  function reloadFiles() {
    shipmentsFile.reload()
    sourcesFile.reload()
  }

  // "Refresh now": the oneshot service serializes with the hourly timer.
  function refresh() {
    Quickshell.execDetached(["systemctl", "--user", "start", "--no-block", root.refreshUnit])
  }

  // Returns true when the text was taken (the field can clear).
  function add(text) {
    var id = Shipments.normalizeTrackingNumber(text)
    if (id === "") return false
    root.addError = ""
    var list = root.queuedAdds.slice()
    list.push({ id: id, text: String(text).trim(), at: new Date().toISOString(), running: false })
    root.queuedAdds = list
    root.startNextAdd()
    return true
  }

  function startNextAdd() {
    if (addProcess.running) return
    var next = root.queuedAdds.filter(function(p) { return !p.running })[0]
    if (!next) return
    root.queuedAdds = root.queuedAdds.map(function(p) { return p === next ? { id: p.id, text: p.text, at: p.at, running: true } : p })
    addProcess.entryId = next.id
    addProcess.command = ["node", root.cliPath, "add", next.text]
    addProcess.running = true
  }

  Process {
    id: addProcess
    property string entryId: ""
    stderr: StdioCollector { id: addStderr }
    onExited: function(exitCode, exitStatus) {
      if (exitCode !== 0) {
        var message = String(addStderr.text || "").trim().replace(/^add: /, "")
        root.addError = message !== "" ? message : "Couldn't add it (is Node.js installed?)"
      }
      var done = addProcess.entryId
      root.queuedAdds = root.queuedAdds.filter(function(p) { return p.id !== done })
      root.reloadFiles()
      if (exitCode === 0) root.refresh()
      Qt.callLater(root.startNextAdd)
    }
  }

  // Takes back a manual add.
  function remove(key) {
    if (!key || String(key).indexOf("queued:") === 0 || root.pendingRemovals.indexOf(key) >= 0) return
    root.pendingRemovals = root.pendingRemovals.concat([key])
    root.startNextRemove()
  }

  function startNextRemove() {
    if (removeProcess.running || root.pendingRemovals.length === 0) return
    removeProcess.key = root.pendingRemovals[0]
    removeProcess.command = ["node", root.cliPath, "remove", removeProcess.key]
    removeProcess.running = true
  }

  Process {
    id: removeProcess
    property string key: ""
    onExited: function(exitCode, exitStatus) {
      var done = removeProcess.key
      if (exitCode === 0) root.removedKeys = root.removedKeys.concat([done])
      root.reloadFiles()
      root.pendingRemovals = root.pendingRemovals.filter(function(k) { return k !== done })
      Qt.callLater(root.startNextRemove)
    }
  }

  // Installs (or refreshes) the timer and service units; idempotent.
  Process {
    id: installProcess
    command: ["node", root.cliPath, "install"]
  }

  Timer {
    interval: 60000
    repeat: true
    running: true
    onTriggered: root.nowMs = Date.now()
  }

  Component.onCompleted: installProcess.running = true
}
