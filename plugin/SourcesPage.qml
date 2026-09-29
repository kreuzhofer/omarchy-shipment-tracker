// The Sources page of the popup (#18 variant B): one place for first-run
// setup and for managing Connections later. Accordion rows DHL, Amazon (one
// entry per account) and Microsoft 365 mail, each with its state summary;
// only one is open, and when the page opens the first Source not set up yet
// is (Store.openRow). Below: the notifications switch (the footer bell's
// setting), uninstalling the refresh timer, and Done.
import QtQuick
import qs.Commons
import qs.Ui
import "Shipments.js" as Shipments

Column {
  id: root
  property var store: null
  property color fg: Color.foreground
  property string ff: Style.font.family
  // While the Amazon label field has focus the panel's shortcuts are off.
  readonly property bool editing: amazonSetup.editing
  readonly property var login: store ? store.activeLogin : null
  property bool confirmUninstall: false
  spacing: Style.space(6)

  function toneOf(summary) {
    if (summary.toLowerCase().indexOf("need") >= 0 || summary === "Can't be read") return "bad"
    if (summary === "Not connected" || summary.indexOf("Connecting") >= 0) return ""
    return "good"
  }

  // ---- Header
  Item {
    width: parent.width
    height: Math.max(backButton.implicitHeight, heading.implicitHeight)
    PanelActionButton {
      id: backButton
      anchors.verticalCenter: parent.verticalCenter
      iconText: "\u{F004D}"
      tooltipText: "Back to Shipments"
      foreground: root.fg
      onClicked: root.store.setPage("list")
    }
    Column {
      id: heading
      anchors.left: backButton.right
      anchors.leftMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      Text { text: "Sources"; color: root.fg; font.family: root.ff; font.pixelSize: Style.font.heading; font.bold: true }
      Text { text: "Where Shipments are found · all optional"; color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.caption }
    }
  }

  // ---- The rows
  SourceRow {
    id: dhlRow
    width: root.width
    store: root.store; fg: root.fg; ff: root.ff
    row: "dhl"
    glyph: "\u{F053D}"
    name: "DHL"
    subtitle: "dhl.de account"
    summary: root.store ? Shipments.rowSummary(root.store.connection("dhl"), !!root.login && root.login.key === "dhl") : ""
    tone: root.toneOf(summary)
    DhlSetup { width: parent.width; store: root.store; fg: root.fg; ff: root.ff }
  }

  SourceRow {
    width: root.width
    store: root.store; fg: root.fg; ff: root.ff
    row: "amazon"
    glyph: "\u{F0110}"
    name: "Amazon"
    subtitle: "one entry per account"
    summary: root.store ? Shipments.amazonSummary(root.store.amazonAccounts, root.login ? root.login.key : "") : ""
    tone: root.toneOf(summary)
    AmazonSetup { id: amazonSetup; width: parent.width; store: root.store; fg: root.fg; ff: root.ff }
  }

  SourceRow {
    width: root.width
    store: root.store; fg: root.fg; ff: root.ff
    row: "mail"
    glyph: "\u{F01F0}"
    name: "Microsoft 365 mail"
    subtitle: "optional · Amazon Orders from mail"
    summary: root.store ? Shipments.rowSummary(root.store.connection("mail"), !!root.login && root.login.key === "mail") : ""
    tone: root.toneOf(summary)
    MailSetup { width: parent.width; store: root.store; fg: root.fg; ff: root.ff }
  }

  PanelSeparator { foreground: root.fg }

  // ---- Notifications: the same setting as the footer bell.
  Toggle {
    width: root.width
    label: "Notify on Status changes"
    description: "Out for delivery, Ready for pickup, Problems, delays and new Incoming Shipments. Never for what the first sync finds."
    checked: !root.store || root.store.notificationsOn
    foreground: root.fg; fontFamily: root.ff
    onClicked: root.store.toggleNotifications()
  }

  // ---- The refresh timer, and Done
  Item {
    width: root.width
    height: Math.max(timerRow.implicitHeight, doneButton.implicitHeight)
    Row {
      id: timerRow
      anchors.left: parent.left
      anchors.right: doneButton.left
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(6)
      readonly property bool installed: !root.store || root.store.timerInstalled !== false
      Text {
        id: timerText
        anchors.verticalCenter: parent.verticalCenter
        width: Math.min(implicitWidth, timerRow.width - timerButtons.implicitWidth - timerRow.spacing)
        wrapMode: Text.WordWrap
        text: root.confirmUninstall ? "Stop refreshing and remove the timer?"
          : timerRow.installed ? "Refreshes hourly in the background" : "Background refresh is off"
        color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.caption
      }
      Row {
        id: timerButtons
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(4)
        Button {
          visible: !root.confirmUninstall
          enabled: !!root.store && !root.store.timerBusy && root.store.nodeOk !== false
          opacity: enabled ? 1 : 0.45
          bordered: true; fontSize: Style.font.caption
          text: timerRow.installed ? "Uninstall timer" : "Install timer"
          onClicked: {
            if (timerRow.installed) root.confirmUninstall = true
            else root.store.installTimer()
          }
        }
        Button {
          visible: root.confirmUninstall
          bordered: true; fontSize: Style.font.caption; text: "Uninstall"
          onClicked: { root.confirmUninstall = false; root.store.uninstallTimer() }
        }
        Button {
          visible: root.confirmUninstall
          fontSize: Style.font.caption; text: "Keep"
          onClicked: root.confirmUninstall = false
        }
      }
    }
    Button {
      id: doneButton
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      selected: true
      text: "Done"
      onClicked: root.store.setPage("list")
    }
  }
  // After uninstalling: why the timer may come back.
  Text {
    visible: !!root.store && root.store.timerInstalled === false
    width: root.width
    wrapMode: Text.WordWrap
    text: "The widget installs the timer again when the shell starts. To keep it off, remove the widget from the bar."
    color: Qt.darker(root.fg, 1.6); font.family: root.ff; font.pixelSize: Style.font.caption
  }
}
