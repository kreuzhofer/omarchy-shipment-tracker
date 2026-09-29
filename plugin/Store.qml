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
  // Dismissed (#35): the CLI stores it in shipments.json (`dismissedAt`). A
  // click shows at once through `dismissOverrides` ({ key: true | false })
  // until the file says the same; `dismissQueue` holds the CLI calls to make.
  property var dismissOverrides: ({})
  property var dismissQueue: []
  // The footer's "N dismissed · show" reveals Dismissed rows (dimmed).
  property bool showDismissed: false
  property double nowMs: Date.now()
  // The bar widget, which owns the notifications setting.
  property var host: null
  readonly property bool notificationsOn: host ? host.notificationsOn === true : true
  readonly property string omarchyBin: Quickshell.env("OMARCHY_PATH") ? Quickshell.env("OMARCHY_PATH") + "/bin/" : ""

  // The header's 7 / 30 days switch: the list shows Shipments whose last change
  // falls in the last `days` days (retention keeps at most 30).
  property int days: 7
  readonly property string lastRun: sourcesState.lastRun || ""
  // Every Shipment, Dismissed ones included, each with `dismissed` set.
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
    var overrides = dismissOverrides
    rows = rows.map(function(s) {
      var o = overrides[s.key]
      return Object.assign({}, s, { dismissed: o !== undefined ? o : !!s.dismissedAt })
    })
    return queued.concat(rows).sort(Shipments.byUrgency)
  }
  // The Shipments that aren't Dismissed: what counts towards "need you", the
  // bar icon and its tooltip.
  readonly property var activeShipments: shipments.filter(function(s) { return !s.dismissed })
  // `shipments` within the 7 / 30 days window, Dismissed ones included. Manual
  // adds waiting for `add` always show.
  readonly property var recentAll: {
    var cutoff = nowMs - days * 864e5
    return shipments.filter(function(s) {
      return String(s.key).indexOf("queued:") === 0 || new Date(s.changedAt).getTime() >= cutoff
    })
  }
  // What the list shows: Dismissed rows only after "show".
  readonly property var recentShipments: showDismissed ? recentAll : recentAll.filter(function(s) { return !s.dismissed })
  readonly property int dismissedCount: recentAll.filter(function(s) { return s.dismissed }).length
  onDismissedCountChanged: if (dismissedCount === 0) showDismissed = false
  // Nothing tracked and no Connection set up: the first-run empty state.
  readonly property bool nothingTracked: (shipmentsState.shipments || []).length === 0 && queuedAdds.length === 0
    && Object.keys(sourcesState.connections || {}).every(function(k) {
      var c = sourcesState.connections[k]
      return !c || c.health === "not-set-up"
    })

  function setDays(n) {
    if (n === 7 || n === 30) root.days = n
  }

  // Connections the user must fix or that can't be read, one banner each:
  // [{ key, connection }], DHL first. They count as "need you".
  readonly property var troubled: {
    var c = sourcesState.connections || {}
    return Object.keys(c).filter(function(k) { return Shipments.isTroubled(c[k]) }).sort(Shipments.connectionOrder)
      .map(function(k) { return { key: k, connection: c[k] } })
  }
  readonly property int troubledCount: troubled.length
  // Any Connection past "not set up": until then the bar reads "not set up".
  readonly property bool anySetUp: {
    var c = sourcesState.connections || {}
    return Object.keys(c).some(function(k) { return c[k] && c[k].health && c[k].health !== "not-set-up" })
  }
  // The bar icon: active when something needs the user; tooltip "N need you · M arriving today".
  readonly property bool needsYou: Shipments.needsYou(activeShipments, troubledCount)
  readonly property string tooltip: Shipments.tooltip(activeShipments, troubledCount, nowMs, anySetUp)
  // Offline: "updated … ago" is the last run that got through.
  readonly property string lastOnline: sourcesState.lastOnline || lastRun
  // A run that died without clearing `refreshing` stops counting after 15 min.
  readonly property bool refreshing: !!sourcesState.refreshing && !!sourcesState.refreshing.startedAt
    && nowMs - new Date(sourcesState.refreshing.startedAt).getTime() < 15 * 6e4
  readonly property string summary: Shipments.summary(activeShipments, troubledCount, nowMs)

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
      root.settleDismissOverrides()
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

  // Retry on a source-down banner: the refresh service for that one
  // Connection (the template instance runs `refresh --source <key>`).
  function retry(key) {
    if (!key) return
    Quickshell.execDetached(["systemctl", "--user", "start", "--no-block", "shipment-tracker-refresh@" + Shipments.systemdEscape(key) + ".service"])
  }

  // ---- Logins (spec #21, "Login window lifecycle"). `login <key>` runs as a
  // transient unit, so it survives a shell restart and can't run twice; the
  // CLI records its progress in the Connection's `login` field.

  // Log in was clicked and the CLI hasn't written its `login` field yet.
  property string startingLogin: ""
  // The one Login in progress, { key, connection }, or null.
  readonly property var activeLogin: {
    var c = sourcesState.connections || {}
    var keys = Object.keys(c).filter(function(k) { return Shipments.loginActive(c[k], root.nowMs) })
    if (keys.length > 0) return { key: keys[0], connection: c[keys[0]] }
    return startingLogin !== "" ? { key: startingLogin, connection: c[startingLogin] || null } : null
  }
  // Why the other Log in buttons are disabled.
  readonly property string loginBlockedText: activeLogin
    ? "Finish the " + Shipments.connectionName(activeLogin.key, activeLogin.connection) + " login first" : ""
  onActiveLoginChanged: {
    if (startingLogin !== "" && activeLogin && activeLogin.connection && activeLogin.connection.login) startingLogin = ""
    loginTick.running = !!activeLogin
  }

  // Log in / Open on a needs-login banner. One Login at a time.
  function login(key) {
    if (!key || root.activeLogin || loginProcess.running) return
    var unit = Shipments.loginUnit(key)
    root.startingLogin = key
    loginProcess.command = ["systemd-run", "--user", "--collect", "--quiet", "--unit=" + unit,
      "--setenv=SHIPMENT_TRACKER_UNIT=" + unit, "--property=RuntimeMaxSec=20min",
      "node", root.cliPath, "login", key]
    loginProcess.running = true
  }

  // Cancel on the progress banner: stopping the unit ends the Login as cancelled.
  function cancelLogin() {
    if (!root.activeLogin) return
    Quickshell.execDetached(["systemctl", "--user", "stop", "--no-block", Shipments.loginUnit(root.activeLogin.key)])
    root.startingLogin = ""
  }

  Process {
    id: loginProcess
    // systemd-run returns once the unit started; it fails when it can't.
    onExited: function(exitCode, exitStatus) { if (exitCode !== 0) root.startingLogin = "" }
  }

  // The CLI writes `login` within a second; give up the optimistic banner
  // if it never does (Node missing, unit failed at once).
  Timer {
    interval: 15000
    running: root.startingLogin !== ""
    onTriggered: root.startingLogin = ""
  }

  // The countdown in the progress banner.
  Timer {
    id: loginTick
    interval: 15000
    repeat: true
    onTriggered: root.nowMs = Date.now()
  }

  // On load: a Login whose unit died with the shell's session (crash,
  // reboot) is cleared as failed, so nothing sticks at "Connecting…".
  Process {
    id: clearStaleProcess
    command: ["node", root.cliPath, "clear-stale-logins"]
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

  // Dismiss (true) or bring back (false) a Shipment; see Dismissed in CONTEXT.md.
  function setDismissed(key, value) {
    if (!key || String(key).indexOf("queued:") === 0) return
    var o = Object.assign({}, root.dismissOverrides)
    o[key] = value === true
    root.dismissOverrides = o
    root.dismissQueue = root.dismissQueue.concat([{ key: key, dismiss: value === true }])
    root.startNextDismiss()
  }
  function dismiss(key) { root.setDismissed(key, true) }
  function undismiss(key) { root.setDismissed(key, false) }

  // Drops the overrides shipments.json now agrees with (or no longer lists),
  // unless a CLI call for that key is still to come.
  function settleDismissOverrides() {
    var keys = Object.keys(root.dismissOverrides)
    if (keys.length === 0) return
    var inFile = {}
    ;(root.shipmentsState.shipments || []).forEach(function(s) { inFile[s.key] = !!s.dismissedAt })
    var waiting = {}
    root.dismissQueue.forEach(function(d) { waiting[d.key] = true })
    var o = {}
    keys.forEach(function(k) {
      if (waiting[k] || (inFile[k] !== undefined && inFile[k] !== root.dismissOverrides[k])) o[k] = root.dismissOverrides[k]
    })
    root.dismissOverrides = o
  }

  function startNextDismiss() {
    if (dismissProcess.running || root.dismissQueue.length === 0) return
    var next = root.dismissQueue[0]
    dismissProcess.command = ["node", root.cliPath, next.dismiss ? "dismiss" : "undismiss", next.key]
    dismissProcess.running = true
  }

  Process {
    id: dismissProcess
    onExited: function(exitCode, exitStatus) {
      var done = root.dismissQueue[0]
      root.dismissQueue = root.dismissQueue.slice(1)
      // A failed call (e.g. the Shipment is gone) shows the file's state again.
      if (exitCode !== 0 && done && root.dismissOverrides[done.key] === done.dismiss) {
        var o = Object.assign({}, root.dismissOverrides)
        delete o[done.key]
        root.dismissOverrides = o
      }
      root.reloadFiles()
      Qt.callLater(root.startNextDismiss)
    }
  }

  // ---- The Sources page (#31; #18 variant B). The popup shows one page at a
  // time: "list", "sources" (the first Source not set up yet opens by itself)
  // or "sources:<row>" with row dhl, amazon, mail or none (all closed).
  property string page: "list"
  function setPage(name) {
    var p = String(name || "list")
    if (p !== "list" && p !== "sources" && p.indexOf("sources:") !== 0) return
    // sources:amazon:<label> and sources:<label> open the Amazon row.
    var row = p.indexOf("sources:") === 0 ? p.substring(8) : ""
    if (row !== "" && ["dhl", "amazon", "mail", "none"].indexOf(row) < 0) p = "sources:amazon"
    root.page = p
    if (p !== "list") { root.checkNode(); root.checkTimer() }
  }
  readonly property bool onSources: page !== "list"
  // The accordion row that is open ("" for none).
  readonly property string openRow: {
    if (page.indexOf("sources:") === 0) return page === "sources:none" ? "" : page.substring(8)
    if (!Shipments.isSetUp(connection("dhl"))) return "dhl"
    if (!amazonAccounts.some(function(a) { return Shipments.isSetUp(a.connection) })) return "amazon"
    if (mailAvailable && !Shipments.isSetUp(connection("mail"))) return "mail"
    return ""
  }
  function toggleRow(row) { root.setPage(root.openRow === row ? "sources:none" : "sources:" + row) }

  function connection(key) {
    var c = sourcesState.connections || {}
    return c[key] || null
  }
  // The Amazon accounts in the order they were added: [{ key, connection }].
  readonly property var amazonAccounts: {
    var c = sourcesState.connections || {}
    return Object.keys(c).filter(function(k) { return k.indexOf("amazon:") === 0 && c[k] })
      .map(function(k) { return { key: k, connection: c[k] } })
  }
  // Microsoft 365 mail comes with #34. Until then its row is a placeholder
  // and never opens by itself; #34 sets this to true.
  readonly property bool mailAvailable: false

  // Node.js runs the CLI: null until checked, then true / false. Without it
  // the Sources rows and the add field offer to install it.
  property var nodeOk: null
  property bool nodeInstalling: false
  function checkNode() { if (!nodeCheck.running) nodeCheck.running = true }
  // `omarchy pkg add` asks for sudo, so it runs in Omarchy's floating terminal.
  function installNode() {
    root.nodeInstalling = true
    Quickshell.execDetached([root.omarchyBin + "omarchy-launch-floating-terminal-with-presentation", "omarchy pkg add nodejs npm"])
  }
  Process {
    id: nodeCheck
    command: ["sh", "-c", "command -v node >/dev/null"]
    onExited: function(exitCode, exitStatus) {
      var was = root.nodeOk
      root.nodeOk = exitCode === 0
      if (!root.nodeOk) return
      root.nodeInstalling = false
      // What failed on load without Node.
      if (was === false) {
        installProcess.running = true
        clearStaleProcess.running = true
      }
    }
  }
  // While the install terminal is open, look for Node every few seconds.
  Timer {
    interval: 3000
    repeat: true
    running: root.nodeInstalling
    onTriggered: root.checkNode()
  }
  Timer {
    interval: 10 * 60000
    running: root.nodeInstalling
    onTriggered: root.nodeInstalling = false
  }

  // The Amazon add form: open while there's no account, else behind
  // "+ Add another Amazon account". The draft survives closing the popup.
  property bool addingAccount: false
  property string draftLabel: ""
  property bool draftRisk: false
  property string accountError: ""
  readonly property bool addingAccountRuns: addAccountProcess.running
  readonly property string draftProblem: Shipments.labelProblem(draftLabel, amazonAccounts)
  readonly property bool canAddAccount: draftProblem === "" && draftRisk && !activeLogin
    && !addAccountProcess.running && nodeOk !== false

  // `accounts add <label> --accept-risk` (the risk accepted for this account
  // only), then its Login.
  function addAccount() {
    if (!root.canAddAccount) return
    var label = root.draftLabel.trim()
    root.accountError = ""
    addAccountProcess.label = label
    addAccountProcess.command = ["node", root.cliPath, "accounts", "add", label, "--accept-risk"]
    addAccountProcess.running = true
  }
  function cancelAddAccount() {
    root.addingAccount = false
    root.draftLabel = ""
    root.draftRisk = false
    root.accountError = ""
  }

  Process {
    id: addAccountProcess
    property string label: ""
    stderr: StdioCollector { id: accountStderr }
    onExited: function(exitCode, exitStatus) {
      if (exitCode !== 0) {
        var message = String(accountStderr.text || "").trim().replace(/^accounts: /, "")
        root.accountError = message !== "" ? message : "Couldn't add the account (is Node.js installed?)"
        return
      }
      root.cancelAddAccount()
      root.reloadFiles()
      root.login("amazon:" + addAccountProcess.label)
    }
  }

  // ---- Removing and disconnecting (#32). Each Connection's row asks first,
  // inline (RemoveConfirm.qml), one row at a time. An Amazon account runs
  // `accounts remove <label>` (up to 90 s while a refresh reads it), DHL and
  // mail `disconnect <key>`. The rows and the list follow sources.json and
  // shipments.json; no Connection left set up is the first-run state.
  property string confirmingRemoval: ""
  property string removingKey: ""
  property string removeError: ""
  property string removeErrorKey: ""
  readonly property bool removalRuns: removeConnectionProcess.running
  function askRemove(key) {
    if (!key || removeConnectionProcess.running) return
    root.removeError = ""
    root.confirmingRemoval = key
  }
  function keepConnection() { root.confirmingRemoval = "" }
  function removeConnection(key) {
    if (!key || removeConnectionProcess.running) return
    root.confirmingRemoval = ""
    root.removeError = ""
    root.removingKey = key
    removeConnectionProcess.command = key.indexOf("amazon:") === 0
      ? ["node", root.cliPath, "accounts", "remove", key.substring(7)]
      : ["node", root.cliPath, "disconnect", key]
    removeConnectionProcess.running = true
  }
  Process {
    id: removeConnectionProcess
    stderr: StdioCollector { id: removeStderr }
    onExited: function(exitCode, exitStatus) {
      if (exitCode !== 0) {
        var message = String(removeStderr.text || "").trim().replace(/^(accounts|disconnect): /, "")
        root.removeError = message !== "" ? message : "Couldn't remove it (is Node.js installed?)"
        root.removeErrorKey = root.removingKey
      }
      root.removingKey = ""
      root.reloadFiles()
    }
  }

  // The hourly refresh timer: null until checked, then true / false. The
  // Sources page offers uninstalling it (before removing the widget; while
  // the widget stays, it installs the timer again when the shell starts).
  property var timerInstalled: null
  readonly property bool timerBusy: timerProcess.running
  function checkTimer() { if (!timerCheck.running) timerCheck.running = true }
  function uninstallTimer() { root.runTimerCommand("uninstall") }
  function installTimer() { root.runTimerCommand("install") }
  function runTimerCommand(command) {
    if (timerProcess.running) return
    timerProcess.command = ["node", root.cliPath, command]
    timerProcess.running = true
  }
  Process {
    id: timerCheck
    command: ["systemctl", "--user", "is-enabled", "--quiet", "shipment-tracker-refresh.timer"]
    onExited: function(exitCode, exitStatus) { root.timerInstalled = exitCode === 0 }
  }
  Process {
    id: timerProcess
    onExited: function(exitCode, exitStatus) { root.checkTimer() }
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

  Component.onCompleted: {
    installProcess.running = true
    clearStaleProcess.running = true
    checkNode()
  }
}
