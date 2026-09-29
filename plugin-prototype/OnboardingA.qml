// PROTOTYPE #18 variant A: a step-by-step wizard inside the popup.
// First click on the bar icon shows a welcome screen, then one step per
// Source (DHL → Amazon → Mail → Notifications), then a summary, then the list.
// Afterwards the gear re-opens the same steps as tabs; a banner's "Log in"
// jumps straight to that Source's step.
import QtQuick
import qs.Commons
import qs.Ui

Column {
  id: root
  property var host: null
  readonly property bool editing: (listView.item && listView.item.editing === true) || setup.editing
  readonly property color fg: host ? host.fg : Color.foreground
  readonly property string ff: host ? host.fontFamily : Style.font.family
  readonly property var steps: [
    { key: "dhl", name: "DHL", title: "Connect DHL" },
    { key: "amazon", name: "Amazon", title: "Connect Amazon accounts" },
    { key: "mail", name: "Mail", title: "Connect mail (optional)" },
    { key: "notify", name: "Alerts", title: "Notifications" }
  ]
  readonly property string pageName: !host ? "list" : host.page !== "" ? host.page : (host.wizardDone ? "list" : "welcome")
  readonly property int stepIndex: { for (var i = 0; i < steps.length; i++) if (steps[i].key === pageName) return i; return -1 }
  readonly property bool managing: host && host.wizardDone   // wizard re-opened from the gear or a banner
  function go(p) { host.page = p }
  function finish() { host.wizardDone = true; go("done") }
  function scrollToEnd() { if (listView.item) listView.item.scrollToEnd() }
  function stepOk(key) {
    if (key === "dhl") return host.dhl.state === "ok"
    if (key === "mail") return host.mail.state === "ok"
    if (key === "amazon") return host.accounts.length > 0 && host.accounts.every(function(a) { return a.state === "ok" })
    return true
  }
  function busy(key) {
    var s = key === "dhl" ? host.dhl.state : key === "mail" ? host.mail.state : ""
    if (key === "amazon") return host.accounts.some(function(a) { return a.state === "connecting" || a.state === "syncing" })
    return s === "connecting" || s === "code" || s === "syncing"
  }
  spacing: Style.space(10)

  // ================================================================ list
  Loader {
    id: listView
    width: parent.width
    active: root.pageName === "list"
    visible: active
    sourceComponent: ShipmentList {
      host: root.host
      showGear: true
      gearTip: "Set up Sources"
      emptyTitle: root.host && !root.host.anySource ? "No Sources connected" : "No Shipments in the last " + (root.host ? root.host.days : 7) + " days"
      emptyText: root.host && !root.host.anySource ? "Paste a tracking number or Amazon order ID below, or set up DHL and Amazon to find Shipments automatically." : ""
      emptyActionText: root.host && !root.host.anySource ? "Set up Sources" : ""
      onEmptyAction: root.go("dhl")
      onGearClicked: root.go("dhl")
      onBannerAction: function(src) {
        var step = src.key.indexOf("amazon:") === 0 ? "amazon" : src.key
        if (src.state === "needs-login") root.host.login(src.key)
        if (src.state === "source-down") { root.host.refresh(); return }
        root.go(step)
      }
    }
  }

  // ================================================================ welcome
  Column {
    visible: root.pageName === "welcome"
    width: parent.width
    spacing: Style.space(10)
    topPadding: Style.space(6)
    Text { anchors.horizontalCenter: parent.horizontalCenter; text: "\u{F03D7}"; color: Color.accent; font.family: root.ff; font.pixelSize: Style.font.display * 1.4 }
    Text { anchors.horizontalCenter: parent.horizontalCenter; text: "Your parcels, in the bar"; color: root.fg; font.family: root.ff; font.pixelSize: Style.font.heading; font.bold: true }
    Text {
      width: parent.width; wrapMode: Text.WordWrap; horizontalAlignment: Text.AlignHCenter
      text: "Connect the places your Shipments come from and the list fills itself, hourly. Every Source is optional: pasting a tracking number always works."
      color: Qt.darker(root.fg, 1.4); font.family: root.ff; font.pixelSize: Style.font.bodySmall
    }
    Column {
      anchors.horizontalCenter: parent.horizontalCenter
      spacing: Style.space(4)
      Repeater {
        model: [ ["\u{F053D}", "DHL · Incoming and Outgoing, one login"], ["\u{F0110}", "Amazon · one or more accounts"], ["\u{F01F0}", "Microsoft 365 mail · optional"], ["\u{F009A}", "Notifications on Status changes"] ]
        delegate: Row {
          required property var modelData
          spacing: Style.space(8)
          Text { width: Style.space(20); text: modelData[0]; color: Color.accent; font.family: root.ff; font.pixelSize: Style.font.icon }
          Text { text: modelData[1]; color: root.fg; font.family: root.ff; font.pixelSize: Style.font.bodySmall; anchors.verticalCenter: parent.verticalCenter }
        }
      }
    }
    Row {
      anchors.horizontalCenter: parent.horizontalCenter
      spacing: Style.space(8)
      Button { selected: true; text: "Set up"; onClicked: root.go("dhl") }
      Button { bordered: true; text: "Skip, I'll paste numbers"; onClicked: { root.host.wizardDone = true; root.go("list") } }
    }
  }

  // ================================================================ one step
  Column {
    visible: root.stepIndex >= 0
    width: parent.width
    spacing: Style.space(10)

    // Header: title, "Step n of 4", and step tabs (clickable once set up).
    Item {
      width: parent.width
      height: stepTitle.implicitHeight
      Column {
        id: stepTitle
        Text { text: root.stepIndex >= 0 ? root.steps[root.stepIndex].title : ""; color: root.fg; font.family: root.ff; font.pixelSize: Style.font.heading; font.bold: true }
        Text { text: root.managing ? "Sources · changes apply right away" : "Step " + (root.stepIndex + 1) + " of " + root.steps.length + " · everything can be skipped"
          color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.caption }
      }
    }
    Row {
      width: parent.width
      spacing: Style.space(4)
      Repeater {
        model: root.steps
        delegate: Rectangle {
          required property var modelData
          required property int index
          readonly property bool current: index === root.stepIndex
          readonly property bool ok: root.host && modelData.key !== "notify" && root.stepOk(modelData.key)
          width: (parent.width - Style.space(12)) / 4
          height: tabText.implicitHeight + Style.space(8)
          radius: Style.cornerRadius
          color: current ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.25) : "transparent"
          border.color: current ? Color.accent : Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.25); border.width: 1
          Text { id: tabText; anchors.centerIn: parent; text: (parent.ok ? "\u{F012C} " : (index + 1) + "  ") + modelData.name
            color: parent.current ? root.fg : Qt.darker(root.fg, 1.4); font.family: root.ff; font.pixelSize: Style.font.caption; font.bold: parent.current }
          MouseArea { anchors.fill: parent; enabled: root.managing; cursorShape: Qt.PointingHandCursor; onClicked: root.go(modelData.key) }
        }
      }
    }

    SourceSetup {
      id: setup
      width: parent.width
      host: root.host
      which: root.stepIndex >= 0 ? root.steps[root.stepIndex].key : "dhl"
    }

    PanelSeparator { foreground: root.fg }
    Item {
      width: parent.width
      height: nextBtn.implicitHeight
      Button { visible: !root.managing && root.stepIndex > 0; anchors.left: parent.left; bordered: true; text: "Back"; onClicked: root.go(root.steps[root.stepIndex - 1].key) }
      Button { visible: root.managing; anchors.left: parent.left; bordered: true; iconText: "\u{F004D}"; text: "Shipments"; onClicked: root.go("list") }
      Button {
        id: nextBtn
        visible: !root.managing
        anchors.right: parent.right
        readonly property string key: root.stepIndex >= 0 ? root.steps[root.stepIndex].key : ""
        readonly property bool last: root.stepIndex === root.steps.length - 1
        selected: key === "notify" || root.stepOk(key)
        bordered: !selected
        text: last ? "Finish" : (root.stepOk(key) ? "Next" : root.busy(key) ? "Continue in background" : "Skip")
        onClicked: last ? root.finish() : root.go(root.steps[root.stepIndex + 1].key)
      }
    }
  }

  // ================================================================ done
  Column {
    visible: root.pageName === "done"
    width: parent.width
    spacing: Style.space(8)
    Text { text: "You're set"; color: root.fg; font.family: root.ff; font.pixelSize: Style.font.heading; font.bold: true }
    Repeater {
      model: root.host ? [ ["DHL", root.host.dhl.state] ].concat(root.host.accounts.map(function(a) { return ["Amazon · " + a.label, a.state] })).concat([["Mail", root.host.mail.state], ["Notifications", root.host.notificationsOn ? "ok" : "none"]]) : []
      delegate: Row {
        required property var modelData
        spacing: Style.space(8)
        Text { text: modelData[1] === "ok" ? "\u{F05E0}" : modelData[1] === "none" ? "\u{F0766}" : "\u{F04E6}"; color: modelData[1] === "ok" ? Color.accent : Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.icon }
        Text { text: modelData[0] + " · " + (modelData[1] === "ok" ? "on" : modelData[1] === "none" ? "skipped" : "finishing in the background"); color: root.fg; font.family: root.ff; font.pixelSize: Style.font.bodySmall; anchors.verticalCenter: parent.verticalCenter }
      }
    }
    Text { width: parent.width; wrapMode: Text.WordWrap; text: "Change Sources any time with the gear in the popup header."; color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.caption }
    Button { anchors.right: parent.right; selected: true; text: "Show Shipments"; onClicked: root.go("list") }
  }
}
