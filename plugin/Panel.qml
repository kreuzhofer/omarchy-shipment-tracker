// The popup, anchored to the bar icon. Hosts the Store (files + CLI) and the
// list page.
//
// IPC, for screenshot checks:
//   omarchy-shell kreuzhofer.shipment-tracker show|hide|toggle
//   omarchy-shell kreuzhofer.shipment-tracker refresh    start the refresh service
//   omarchy-shell kreuzhofer.shipment-tracker add <n>    same as the footer add field
//   omarchy-shell kreuzhofer.shipment-tracker remove <k> same as a row's remove button
//   omarchy-shell kreuzhofer.shipment-tracker days 7|30  the header's 7 / 30 days switch
//   omarchy-shell kreuzhofer.shipment-tracker scroll     scroll the list to its end
//   omarchy-shell kreuzhofer.shipment-tracker retry <key> same as a banner's Retry
//   omarchy-shell kreuzhofer.shipment-tracker dismiss <k> / undismiss <k>   a row's dismiss button
//   omarchy-shell kreuzhofer.shipment-tracker showDismissed <true|false>  the footer's "show"
//   omarchy-shell kreuzhofer.shipment-tracker login <key> same as a banner's Log in
//   omarchy-shell kreuzhofer.shipment-tracker cancelLogin same as the progress banner's Cancel
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

  Store { id: backend; host: root.hostWidget }

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
    function add(text: string): void { backend.add(text) }
    function remove(key: string): void { backend.remove(key) }
    function days(n: int): void { backend.setDays(n) }
    function scroll(): void { list.scrollToEnd() }
    function retry(key: string): void { backend.retry(key) }
    function dismiss(key: string): void { backend.dismiss(key) }
    function undismiss(key: string): void { backend.undismiss(key) }
    function showDismissed(show: bool): void { backend.showDismissed = show }
    function login(key: string): void { backend.login(key) }
    function cancelLogin(): void { backend.cancelLogin() }
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
