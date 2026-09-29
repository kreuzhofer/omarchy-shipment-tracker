// PROTOTYPE (#18) FAKE backend: stands in for the shipment-tracker CLI and
// sources.json (#12). Every login is a timer; all state is in memory and
// resets with the shell. The variants get this object as `host`.
import QtQuick
import qs.Commons
import "FakeData.js" as Fake

Item {
  id: root
  // ---------------------------------------------------------------- fake backend
  // Source states as sources.json would carry them (#12), plus the transient
  // UI-only states of a login in progress:
  //   none         not set up
  //   connecting   dedicated Chrome window open, waiting for the user (DHL/Amazon)
  //   code         device code shown, waiting for the user (mail)
  //   syncing      login caught, first refresh running
  //   ok | needs-login | source-down
  property var dhl: ({ state: "none" })
  property var accounts: []            // [{ label, state }] in the order added
  property var mail: ({ state: "none" })
  property bool nodeOk: true
  property bool hold: false            // freeze fake timers for screenshots
  property var pending: ({})           // key -> { at, next }

  // View state the variants interpret (see header). Kept here so IPC can set it.
  property string page: ""
  property bool wizardDone: false      // A: wizard finished or skipped
  property var dismissed: ({})         // C: setup cards put off with "Not now"
  property string draftLabel: ""       // Amazon add form
  property bool draftRisk: false
  property bool addingAccount: false

  readonly property string deviceCode: "F7KQ2MXPL"
  readonly property string deviceUrl: "https://microsoft.com/devicelogin"

  function sourceState(key) {
    if (key === "dhl") return dhl.state
    if (key === "mail") return mail.state
    var a = account(key.replace(/^amazon:/, ""))
    return a ? a.state : "none"
  }
  function account(label) {
    for (var i = 0; i < accounts.length; i++) if (accounts[i].label === label) return accounts[i]
    return null
  }
  function setState(key, state) {
    if (key === "dhl") { dhl = { state: state, fixing: dhl.fixing }; return }
    if (key === "mail") { mail = { state: state, fixing: mail.fixing }; return }
    var label = key.replace(/^amazon:/, "")
    var list = accounts.slice()
    var found = false
    for (var i = 0; i < list.length; i++) if (list[i].label === label) {
      found = true
      if (state === "none") list.splice(i, 1)
      else list[i] = { label: label, state: state, fixing: list[i].fixing }
      break
    }
    if (!found && state !== "none") list.push({ label: label, state: state })
    accounts = list
  }
  function setFixing(key, on) {
    if (key === "dhl") dhl = { state: dhl.state, fixing: on }
    else if (key === "mail") mail = { state: mail.state, fixing: on }
    else {
      var list = accounts.slice()
      for (var i = 0; i < list.length; i++) if ("amazon:" + list[i].label === key) list[i] = { label: list[i].label, state: list[i].state, fixing: on }
      accounts = list
    }
  }
  function schedule(key, ms, next) {
    var p = {}
    for (var k in pending) p[k] = pending[k]
    if (next === "") delete p[key]; else p[key] = { at: Date.now() + ms, next: next }
    pending = p
  }

  // Fake login: DHL catches dhllogin:// over CDP, Amazon sees the order page,
  // mail completes the device code. Then a first sync, then ok.
  function login(key) {
    var was = sourceState(key)
    setFixing(key, was !== "none" && was !== "connecting" && was !== "code")
    if (key === "mail") { setState(key, "code"); schedule(key, 9000, "syncing") }
    else { setState(key, "connecting"); schedule(key, key === "dhl" ? 3500 : 4500, "syncing") }
  }
  function cancel(key) {
    schedule(key, 0, "")
    var fixing = key === "dhl" ? dhl.fixing : key === "mail" ? mail.fixing : (account(key.replace(/^amazon:/, "")) || {}).fixing
    setState(key, fixing ? "needs-login" : "none")
  }
  function remove(key) { schedule(key, 0, ""); setState(key, "none") }
  function addAccount(label) {
    label = String(label || "").trim()
    if (label === "" || account(label)) return false
    setState("amazon:" + label, "connecting")
    login("amazon:" + label)
    draftLabel = ""; draftRisk = false; addingAccount = false
    return true
  }
  function installNode() { nodeInstalling = true; nodeTimer.restart() }
  property bool nodeInstalling: false
  Timer { id: nodeTimer; interval: 2500; onTriggered: { root.nodeInstalling = false; root.nodeOk = true } }

  Timer {
    interval: 250; repeat: true; running: !root.hold && Object.keys(root.pending).length > 0
    onTriggered: {
      var now = Date.now()
      for (var key in root.pending) {
        var p = root.pending[key]
        if (p.at > now) continue
        root.setState(key, p.next)
        if (p.next === "syncing") root.schedule(key, 1800, "ok")
        else { root.schedule(key, 0, ""); root.setFixing(key, false) }
      }
    }
  }

  function applyPreset(name) {
    pending = ({}); dismissed = ({}); nodeOk = true; addingAccount = false; draftLabel = ""; draftRisk = false; added = []
    dhl = { state: "none" }; accounts = []; mail = { state: "none" }; wizardDone = false; page = ""
    if (name === "fresh") return
    wizardDone = true
    dhl = { state: "ok" }
    if (name === "dhl") { dismissed = { dhl: true, amazon: true, mail: true, notify: true }; return }
    accounts = [{ label: "Personal", state: "ok" }, { label: "Business", state: name === "needslogin" ? "needs-login" : "ok" }]
    mail = { state: "ok" }
    if (name === "down") dhl = { state: "source-down" }
  }

  // Everything the Shipment list renders.
  readonly property bool anySource: dhl.state !== "none" || accounts.length > 0 || mail.state !== "none"
  readonly property var readyLabels: accounts.filter(function(a) { return a.state === "ok" || a.state === "needs-login" || a.state === "source-down" || (a.state === "connecting" && a.fixing) })
    .map(function(a) { return a.label })
  readonly property bool dhlHasData: dhl.state === "ok" || dhl.state === "needs-login" || dhl.state === "source-down" || (dhl.state === "connecting" && dhl.fixing === true)
  property var added: []
  property string lastRefresh: Fake.lastRefresh
  property bool refreshing: false
  readonly property var shipments: Fake.sorted(added.concat(Fake.forSources(days, dhlHasData, readyLabels)))
  // Sources the banner shows: broken ones and ones being fixed from the banner.
  readonly property var troubled: {
    var out = []
    function push(key, source, acct, s) {
      if (s.state === "needs-login" || s.state === "source-down" || (s.fixing && s.state !== "ok")) out.push({ key: key, source: source, account: acct, state: s.state })
    }
    push("dhl", "DHL", "", dhl)
    accounts.forEach(function(a) { push("amazon:" + a.label, "Amazon", a.label, a) })
    push("mail", "Mail", "", mail)
    return out
  }
  readonly property bool notificationsOn: hostWidget ? hostWidget.notificationsOn : true
  property var hostWidget: null
  property color fg: Color.foreground
  property string fontFamily: Style.font.family
  property int days: 7

  signal closeRequested()
  function openUrl(url) { Qt.openUrlExternally(url); closeRequested() }
  function addManual(text) {
    var id = String(text || "").trim()
    if (id === "") return false
    var own = readyLabels.length ? readyLabels[0] : ""
    added = [Fake.manual(id, own)].concat(added)
    return true
  }
  function refresh() { refreshing = true; refreshTimer.restart() }
  function setNotifications(on) { if (hostWidget) hostWidget.setNotifications(on) }
  function toggleNotifications() { setNotifications(!notificationsOn) }

  Timer { id: refreshTimer; interval: 1200; onTriggered: { root.refreshing = false; root.lastRefresh = new Date().toISOString() } }

}
