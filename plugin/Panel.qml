// The popup, anchored to the bar icon. Hosts the Store (files + CLI) and the
// list page.
//
// IPC, for screenshot checks:
//   omarchy-shell kreuzhofer.shipment-tracker show|hide|toggle
//   omarchy-shell kreuzhofer.shipment-tracker refresh    start the refresh service
import QtQuick
import Quickshell.Io
import qs.Commons
import qs.Ui

Panel {
  id: root
  moduleName: "kreuzhofer.shipment-tracker"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  property alias store: backend
  readonly property color fg: bar ? bar.foreground : Color.foreground
  readonly property string ff: bar ? bar.fontFamily : Style.font.family

  Store { id: backend }

  onOpenedChanged: if (opened) backend.nowMs = Date.now()

  function openUrl(url) {
    if (!url) return
    Qt.openUrlExternally(url)
    root.close()
  }

  function switchPanel(direction) {
    if (bar && typeof bar.switchPanelFrom === "function") return bar.switchPanelFrom(hostWidget || root, direction)
    return false
  }

  IpcHandler {
    target: "kreuzhofer.shipment-tracker"
    function show(): void { if (!root.opened) root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): void { backend.refresh() }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.hostWidget || root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(470))
    contentHeight: panel.fittedContentHeight(list.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // Typing in the add field must not trigger list shortcuts.
      blocked: list.editing
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      ShipmentList {
        id: list
        anchors.left: parent.left
        anchors.right: parent.right
        store: backend
        fg: root.fg
        ff: root.ff
        onOpenRequested: function(url) { root.openUrl(url) }
        onCloseRequested: root.close()
      }
    }
  }
}
