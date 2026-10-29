// The popup, anchored to the bar icon. Hosts the Store (files + CLI), the
// list page and the Sources page (#31). Closing it returns to the list.
//
// IPC, for screenshot checks:
//   omarchy-shell kreuzhofer.shipment-tracker show|hide|toggle
//   omarchy-shell kreuzhofer.shipment-tracker refresh    start the refresh service
//   omarchy-shell kreuzhofer.shipment-tracker add <n>    same as the footer add field
//   omarchy-shell kreuzhofer.shipment-tracker remove <k> same as a row's remove button
//   omarchy-shell kreuzhofer.shipment-tracker days 7|30  the header's 7 / 30 days switch
//   omarchy-shell kreuzhofer.shipment-tracker scroll     scroll the list to its end
//   omarchy-shell kreuzhofer.shipment-tracker tab incoming|outgoing   the list's Direction tabs
//   omarchy-shell kreuzhofer.shipment-tracker retry <key> same as a banner's Retry
//   omarchy-shell kreuzhofer.shipment-tracker dismiss <k> / undismiss <k>   a row's dismiss button
//   omarchy-shell kreuzhofer.shipment-tracker showDismissed <true|false>  the footer's "show"
//   omarchy-shell kreuzhofer.shipment-tracker login <key> same as a banner's Log in
//   omarchy-shell kreuzhofer.shipment-tracker cancelLogin same as the progress banner's Cancel
//   omarchy-shell kreuzhofer.shipment-tracker page list|sources|sources:<row>
//       the Shipments list, or the Sources page (the first Source not set up
//       opens), or it with one row open: dhl, amazon, mail, none
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

  onOpenedChanged: {
    if (opened) {
      backend.nowMs = Date.now()
      backend.checkNode()
      backend.refreshIfStale()
    } else {
      backend.setPage("list")
    }
  }

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
    function tab(name: string): void { list.setTab(name) }
    function retry(key: string): void { backend.retry(key) }
    function dismiss(key: string): void { backend.dismiss(key) }
    function undismiss(key: string): void { backend.undismiss(key) }
    function showDismissed(show: bool): void { backend.showDismissed = show }
    function login(key: string): void { backend.login(key) }
    function cancelLogin(): void { backend.cancelLogin() }
    function page(name: string): void { backend.setPage(name) }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.hostWidget || root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(470))
    contentHeight: panel.fittedContentHeight(backend.onSources ? sources.implicitHeight : list.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // Typing in the add field must not trigger list shortcuts.
      blocked: list.editing || sources.editing
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      ShipmentList {
        id: list
        visible: !backend.onSources
        anchors.left: parent.left
        anchors.right: parent.right
        store: backend
        fg: root.fg
        ff: root.ff
        onOpenRequested: function(url) { root.openUrl(url) }
        onCloseRequested: root.close()
        onSourcesRequested: backend.setPage("sources")
      }

      // Scrolls when the page is taller than the screen allows.
      Flickable {
        visible: backend.onSources
        anchors.fill: parent
        contentWidth: width
        contentHeight: sources.implicitHeight
        clip: true
        interactive: contentHeight > height
        boundsBehavior: Flickable.StopAtBounds

        SourcesPage {
          id: sources
          width: parent.width
          store: backend
          fg: root.fg
          ff: root.ff
        }
      }
    }
  }
}
