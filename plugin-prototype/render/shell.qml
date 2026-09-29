// PROTOTYPE offscreen render harness for #18: renders every scene below to
// ../screenshots/*.png without the bar (used while the session was locked).
//   cd plugin-prototype/render && QT_QPA_PLATFORM=offscreen QT_SCALE_FACTOR=1.25 quickshell -n -p .
import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "plugin"

ShellRoot {
  FloatingWindow {
    id: win
    implicitWidth: 560; implicitHeight: 1400
    color: "black"
    Rectangle {
      id: stage
      width: 470 + 36
      height: col.implicitHeight + 36
      color: Color.background
      border.color: Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.35); border.width: 2
      QtObject { id: fakeWidget; property bool notificationsOn: true; function setNotifications(v) { notificationsOn = v } }
      FakeBackend { id: backend; hostWidget: fakeWidget; hold: true }
      Column {
        id: col
        x: 18; y: 18; width: 470
        Loader { id: body; width: parent.width; onLoaded: item.host = backend }
      }
    }
    property var scenes: [
      ["A", "A1-welcome", function(b) { b.applyPreset("fresh") }],
      ["A", "A2-dhl-connecting", function(b) { b.applyPreset("fresh"); b.page = "dhl"; b.login("dhl") }],
      ["A", "A3-amazon-add-second", function(b) { b.applyPreset("fresh"); b.page = "amazon"; b.setState("dhl", "ok"); b.setState("amazon:Personal", "ok"); b.addingAccount = true; b.draftLabel = "Business"; b.draftRisk = true }],
      ["A", "A4-mail-device-code", function(b) { b.applyPreset("fresh"); b.page = "mail"; b.setState("dhl", "ok"); b.setState("amazon:Personal", "ok"); b.login("mail") }],
      ["A", "A5-done", function(b) { b.applyPreset("full"); b.wizardDone = true; b.page = "done" }],
      ["A", "A6-list-needs-login", function(b) { b.applyPreset("needslogin") }],
      ["A", "A7-fix-from-banner", function(b) { b.applyPreset("needslogin"); b.login("amazon:Business"); b.page = "amazon" }],
      ["A", "A8-skipped-empty", function(b) { b.applyPreset("fresh"); b.wizardDone = true }],
      ["B", "B1-first-run-empty", function(b) { b.applyPreset("fresh") }],
      ["B", "B2-sources-first-run", function(b) { b.applyPreset("fresh"); b.page = "sources" }],
      ["B", "B3-sources-amazon-risk", function(b) { b.applyPreset("fresh"); b.setState("dhl", "ok"); b.page = "sources:amazon"; b.draftLabel = "Personal" }],
      ["B", "B4-sources-managed", function(b) { b.applyPreset("needslogin"); b.page = "sources:amazon" }],
      ["B", "B5-banner-fixing-inline", function(b) { b.applyPreset("needslogin"); b.login("amazon:Business") }],
      ["B", "B6-sources-mail-code", function(b) { b.applyPreset("dhl"); b.setState("amazon:Personal", "ok"); b.page = "sources:mail"; b.login("mail") }],
      ["B", "B7-node-missing", function(b) { b.applyPreset("fresh"); b.nodeOk = false; b.page = "sources" }],
      ["C", "C1-first-run-dhl-card", function(b) { b.applyPreset("fresh") }],
      ["C", "C2-amazon-card", function(b) { b.applyPreset("fresh"); b.setState("dhl", "ok"); b.draftLabel = "Personal"; b.draftRisk = true }],
      ["C", "C3-list-chips-needs-login", function(b) { b.applyPreset("needslogin"); b.dismissed = { dhl: true, amazon: true, mail: true, notify: true } }],
      ["C", "C4-chip-reopened", function(b) { b.applyPreset("needslogin"); b.dismissed = { dhl: true, amazon: true, mail: true, notify: true }; b.page = "Business" }]
    ]
    property int idx: -1
    function next() {
      idx++
      if (idx >= scenes.length) { Qt.quit(); return }
      var sc = scenes[idx]
      body.source = ""
      sc[2](backend)
      body.source = Qt.resolvedUrl("plugin/Onboarding" + sc[0] + ".qml")
      shot.restart()
    }
    Timer { id: shot; interval: 700; onTriggered: stage.grabToImage(function(r) { r.saveToFile(Quickshell.shellDir + "/../screenshots/" + win.scenes[win.idx][1] + ".png"); win.next() }) }
    Timer { interval: 800; running: true; onTriggered: win.next() }
  }
}
