// PROTOTYPE popup host for #18 (onboarding), built on the #9 popup prototype.
// Renders one of three structurally different onboarding variants plus a loud
// switcher (←/→ or click). FAKE backend: every login is a timer, all state is
// in memory and resets with the shell. Not production code.
//
// Drive it from a shell (every state is reachable):
//   omarchy-shell kreuzhofer.shipments-prototype show A|B|C     open variant
//   omarchy-shell kreuzhofer.shipments-prototype hide
//   omarchy-shell kreuzhofer.shipments-prototype preset fresh|dhl|full|needslogin|down
//   omarchy-shell kreuzhofer.shipments-prototype page <name>
//       A: list|welcome|dhl|amazon|mail|notify|done
//       B: list|sources|sources:dhl|sources:amazon|sources:mail|sources:<label>
//       C: list|dhl|amazon|mail|notify|<label>   (open that setup card)
//   omarchy-shell kreuzhofer.shipments-prototype dhl none|connecting|syncing|ok|needs-login|source-down
//   omarchy-shell kreuzhofer.shipments-prototype mail none|code|syncing|ok|needs-login
//   omarchy-shell kreuzhofer.shipments-prototype amazon <label> none|connecting|ok|needs-login
//   omarchy-shell kreuzhofer.shipments-prototype login <dhl|mail|amazon:<label>>   start a fake login
//   omarchy-shell kreuzhofer.shipments-prototype draft "<label>" true|false        Amazon add form: label + risk opt-in
//   omarchy-shell kreuzhofer.shipments-prototype node true|false                   Node.js present?
//   omarchy-shell kreuzhofer.shipments-prototype hold true|false                   freeze fake timers (screenshots)
//   omarchy-shell kreuzhofer.shipments-prototype days 7|30
//   omarchy-shell kreuzhofer.shipments-prototype scroll
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
  property int variantIndex: 0
  readonly property var variants: [
    { key: "A", name: "Wizard in the popup", file: "OnboardingA.qml" },
    { key: "B", name: "Sources page", file: "OnboardingB.qml" },
    { key: "C", name: "Setup cards in the list", file: "OnboardingC.qml" }
  ]
  readonly property var variant: variants[variantIndex]

  FakeBackend {
    id: backend
    hostWidget: root.hostWidget
    fg: root.bar ? root.bar.foreground : Color.foreground
    fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
    onCloseRequested: root.close()
  }
  function cycle(delta) { variantIndex = (variantIndex + delta + variants.length) % variants.length; backend.page = "" }
  function switchPanel(direction) {
    if (bar && typeof bar.switchPanelFrom === "function") return bar.switchPanelFrom(hostWidget || root, direction)
    return false
  }
  // Read by BarWidget.
  readonly property var shipments: backend.shipments
  readonly property var troubled: backend.troubled
  readonly property bool anySource: backend.anySource

  IpcHandler {
    target: "kreuzhofer.shipments-prototype"
    function show(key: string): void {
      for (var i = 0; i < root.variants.length; i++) if (root.variants[i].key === key) { root.variantIndex = i; backend.page = "" }
      if (!root.opened) root.open()
    }
    function hide(): void { root.close() }
    function preset(name: string): void { backend.applyPreset(name) }
    function page(name: string): void { backend.page = name }
    function dhl(state: string): void { backend.schedule("dhl", 0, ""); backend.setState("dhl", state) }
    function mail(state: string): void { backend.schedule("mail", 0, ""); backend.setState("mail", state) }
    function amazon(label: string, state: string): void { backend.schedule("amazon:" + label, 0, ""); backend.setState("amazon:" + label, state) }
    function login(key: string): void { backend.login(key) }
    function draft(label: string, risk: bool): void { backend.addingAccount = true; backend.draftLabel = label; backend.draftRisk = risk }
    function node(ok: bool): void { backend.nodeOk = ok }
    function hold(on: bool): void { backend.hold = on }
    function days(n: int): void { backend.days = n }
    function scroll(): void { if (body.item && body.item.scrollToEnd) body.item.scrollToEnd() }
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
      // Let text fields receive h/j/k/l/x and arrows while typing.
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
          onLoaded: item.host = backend
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
            Text { text: "PROTOTYPE #18 " + root.variant.key + " · " + root.variant.name; color: "#111"; font.pixelSize: Style.font.bodySmall; font.bold: true }
            Text { text: "▶"; color: "#111"; font.pixelSize: Style.font.body
              MouseArea { anchors.fill: parent; anchors.margins: -6; onClicked: root.cycle(1) } }
          }
        }
      }
    }
  }
}
