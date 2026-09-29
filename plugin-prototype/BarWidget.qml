// PROTOTYPE bar widget for the popup (#9) and onboarding (#18) prototypes. Fake data only.
import QtQuick
import qs.Commons
import qs.Ui
import "FakeData.js" as Fake

BarWidget {
  id: root
  moduleName: "kreuzhofer.shipments-prototype"

  // Active (bar "active" colour) when something needs the user: Ready for
  // pickup, Problem, or a Source that needs a login. No count badge.
  // Before any Source is set up the icon stays idle: an unconfigured widget
  // is not something that "needs you" (#18).
  readonly property var host: panelLoader.item
  readonly property var shown: host ? host.shipments : []
  readonly property int attentionCount: shown.filter(function(s) { return Fake.attention[s.status] }).length + (host ? host.troubled.filter(function(t) { return t.state === "needs-login" || t.state === "source-down" }).length : 0)
  readonly property int todayCount: shown.filter(function(s) { return s.status === "Out for delivery" }).length
  readonly property bool notificationsOn: setting("notifications", true) === true
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function toggle() { if (panelLoader.item) panelLoader.item.toggle() }
  function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }

  function setNotifications(value) {
    var entry = { id: root.moduleName }
    for (var k in root.settings) if (k !== "id") entry[k] = root.settings[k]
    entry.notifications = value
    root.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(root.moduleName, entry)
  }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    target.bar = root.bar
    target.anchorItem = button
    target.hostWidget = root
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight
  onBarChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: { root.injectPanel(); Qt.callLater(root.injectPanel) }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "\u{F03D7}"
    active: root.attentionCount > 0
    tooltipText: root.opened ? "" : (root.host && !root.host.anySource && root.shown.length === 0) ? "Shipments · not set up" : (root.attentionCount > 0 ? root.attentionCount + " need you" : "Shipments") + (root.todayCount > 0 ? " · " + root.todayCount + " arriving today" : "")
    onPressed: function(b) { root.toggle() }
  }
}
