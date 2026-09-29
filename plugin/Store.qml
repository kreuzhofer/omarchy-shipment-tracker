// The plugin's view of the backend. The shipment-tracker CLI owns all data;
// this only watches its two state files, starts CLI commands and the refresh
// service, and keeps the not-yet-written manual adds for immediate feedback.
import QtQuick
import Quickshell
import Quickshell.Io
import "Shipments.js" as Shipments

Item {
  id: root

  readonly property string stateDir: (Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state")) + "/omarchy-shipment-tracker"
  readonly property string cliPath: decodeURIComponent(String(Qt.resolvedUrl("cli/shipment-tracker.mjs")).replace(/^file:\/\//, ""))
  readonly property string refreshUnit: "shipment-tracker-refresh.service"

  property var shipmentsState: ({ shipments: [], events: [] })
  property var sourcesState: ({ lastRun: null, refreshing: null, offline: false, connections: {} })
  // Manual adds typed in the popup that `add` hasn't written yet: [{ id, running }].
  property var pendingAdds: []
  property string addError: ""
  property double nowMs: Date.now()

  readonly property string lastRun: sourcesState.lastRun || ""
  readonly property var shipments: {
    var known = {}
    var rows = (shipmentsState.shipments || []).slice()
    rows.forEach(function(s) { known[s.key] = true })
    var pending = pendingAdds.filter(function(p) { return !known["dhl:" + p.id] }).map(function(p) {
      return { key: "pending:" + p.id, direction: "Incoming", source: "DHL", account: null, carrier: "DHL",
        title: p.id, status: "Unknown", estimate: { text: "Looking up…" }, delayed: false,
        url: Shipments.dhlTrackingUrl(p.id), changedAt: p.at, discoveredAt: p.at }
    })
    // Newest first until the urgency sort lands (#23).
    return pending.concat(rows.sort(function(a, b) { return String(b.discoveredAt).localeCompare(String(a.discoveredAt)) }))
  }

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
    onLoaded: root.shipmentsState = root.parse(text(), root.shipmentsState)
    onLoadFailed: root.shipmentsState = ({ shipments: [], events: [] })
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
    var list = root.pendingAdds.slice()
    list.push({ id: id, text: String(text).trim(), at: new Date().toISOString(), running: false })
    root.pendingAdds = list
    root.startNextAdd()
    return true
  }

  function startNextAdd() {
    if (addProcess.running) return
    var next = root.pendingAdds.filter(function(p) { return !p.running })[0]
    if (!next) return
    root.pendingAdds = root.pendingAdds.map(function(p) { return p === next ? { id: p.id, text: p.text, at: p.at, running: true } : p })
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
      root.pendingAdds = root.pendingAdds.filter(function(p) { return p.id !== done })
      root.reloadFiles()
      if (exitCode === 0) root.refresh()
      Qt.callLater(root.startNextAdd)
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
