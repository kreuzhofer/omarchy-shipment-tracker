// PROTOTYPE popup host for #9: renders one of three structurally different
// variants plus a loud switcher (←/→ or click). Not production code.
//
// Drive it from a shell:
//   omarchy-shell kreuzhofer.shipments-prototype show A   (B, C)
//   omarchy-shell kreuzhofer.shipments-prototype days 30
//   omarchy-shell kreuzhofer.shipments-prototype empty true   (no-Shipments state)
//   omarchy-shell kreuzhofer.shipments-prototype scroll   (scroll list to end)
//   omarchy-shell kreuzhofer.shipments-prototype hide
import QtQuick
import Quickshell.Io
import qs.Commons
import qs.Ui
import "FakeData.js" as Fake

Panel {
  id: root
  moduleName: "kreuzhofer.shipments-prototype"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  property int days: 7
  property int variantIndex: 0
  readonly property var variants: [
    { key: "A", name: "Urgency list", file: "VariantA.qml" },
    { key: "B", name: "Sections by what needs you", file: "VariantB.qml" },
    { key: "C", name: "Direction tabs + progress cards", file: "VariantC.qml" }
  ]
  readonly property var variant: variants[variantIndex]

  // Shared fake state every variant renders. Manual adds live only in memory.
  property var added: []
  property string lastRefresh: Fake.lastRefresh
  property bool refreshing: false
  property bool emptyMode: false // IPC "empty": preview the no-Shipments state
  readonly property var shipments: emptyMode ? added : Fake.sorted(added.concat(Fake.visible(days)))
  readonly property var sources: Fake.sources
  readonly property var troubled: Fake.troubled()
  readonly property bool notificationsOn: hostWidget ? hostWidget.notificationsOn : true
  readonly property color fg: bar ? bar.foreground : Color.foreground
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  function cycle(delta) { variantIndex = (variantIndex + delta + variants.length) % variants.length }
  function openUrl(url) { Qt.openUrlExternally(url); root.close() }
  function addManual(text) {
    var id = String(text || "").trim()
    if (id === "") return false
    added = [Fake.manual(id)].concat(added)
    return true
  }
  function refresh() { refreshing = true; refreshTimer.restart() }
  function toggleNotifications() { if (hostWidget) hostWidget.setNotifications(!notificationsOn) }
  function switchPanel(direction) {
    if (bar && typeof bar.switchPanelFrom === "function") return bar.switchPanelFrom(hostWidget || root, direction)
    return false
  }

  Timer { id: refreshTimer; interval: 1200; onTriggered: { root.refreshing = false; root.lastRefresh = new Date().toISOString() } }

  IpcHandler {
    target: "kreuzhofer.shipments-prototype"
    function show(key: string): void {
      for (var i = 0; i < root.variants.length; i++) if (root.variants[i].key === key) root.variantIndex = i
      if (!root.opened) root.open()
    }
    function days(n: int): void { root.days = n }
    function hide(): void { root.close() }
    function empty(on: bool): void { root.emptyMode = on }
    function scroll(): void { if (body.item) body.item.scrollToEnd() }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.hostWidget || root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(470))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // Let the manual-add field receive h/j/k/l/x and arrows while typing.
      blocked: body.item ? body.item.editing === true : false
      onMoveRequested: function(dx, dy) { if (dx !== 0) root.cycle(dx) }
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: Style.space(10)

        Loader {
          id: body
          width: parent.width
          source: Qt.resolvedUrl(root.variant.file)
          onLoaded: item.host = root
        }

        // Switcher, deliberately loud so it reads as tooling, not design.
        Rectangle {
          anchors.horizontalCenter: parent.horizontalCenter
          width: switcherRow.implicitWidth + Style.space(20)
          height: switcherRow.implicitHeight + Style.space(8)
          radius: height / 2
          color: "#f5c542"

          Row {
            id: switcherRow
            anchors.centerIn: parent
            spacing: Style.space(10)
            Text { text: "◀"; color: "#111"; font.pixelSize: Style.font.body
              MouseArea { anchors.fill: parent; anchors.margins: -6; onClicked: root.cycle(-1) } }
            Text { text: "PROTOTYPE " + root.variant.key + " · " + root.variant.name + " · " + root.days + "d"; color: "#111"; font.pixelSize: Style.font.bodySmall; font.bold: true }
            Text { text: "▶"; color: "#111"; font.pixelSize: Style.font.body
              MouseArea { anchors.fill: parent; anchors.margins: -6; onClicked: root.cycle(1) } }
          }
        }
      }
    }
  }
}
