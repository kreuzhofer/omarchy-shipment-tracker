// PROTOTYPE bar widget for the popup UX prototype (#9). Fake data only.
import QtQuick
import qs.Commons
import qs.Ui
import "FakeData.js" as Fake

BarWidget {
  id: root
  moduleName: "kreuzhofer.shipments-prototype"

  // Active (bar "active" colour) when something needs the user: Ready for
  // pickup, Problem, or a Source that needs a login. No count badge.
  readonly property int attentionCount: Fake.visible(30).filter(function(s) { return Fake.attention[s.status] }).length + Fake.troubled().length
  readonly property int todayCount: Fake.visible(30).filter(function(s) { return s.status === "Out for delivery" }).length
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
    tooltipText: root.opened ? "" : (root.attentionCount > 0 ? root.attentionCount + " need you" : "Shipments") + (root.todayCount > 0 ? " · " + root.todayCount + " arriving today" : "")
    onPressed: function(b) { root.toggle() }
  }
}
