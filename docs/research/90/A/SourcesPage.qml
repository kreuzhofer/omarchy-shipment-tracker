// The Sources page of the popup (#18 variant B): one place for first-run
// setup and for managing Connections later. Accordion rows DHL, Amazon (one
// entry per account) and Microsoft 365 mail, each with its state summary;
// only one is open, and when the page opens the first Source not set up yet
// is (Store.openRow). Below: the notifications switch (the footer bell's
// setting), the background refresh switch (#90 variant A), and Done.
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
    subtitle: "optional · Orders and DHL numbers from mail"
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

  // ---- #90 variant A: background refresh is a switch like the one above.
  // Off on a fresh install; turning it on runs `install`, off runs `uninstall`.
  Toggle {
    width: root.width
    label: "Refresh in the background"
    description: "Adds two systemd user timers: hourly, and every 15 min while a DHL parcel is due. Off: Shipments refresh when you open this popup."
    checked: !!root.store && root.store.timerInstalled === true
    enabled: !!root.store && !root.store.timerBusy && root.store.nodeOk !== false
    foreground: root.fg; fontFamily: root.ff
    onClicked: root.store.timerInstalled ? root.store.uninstallTimer() : root.store.installTimer()
  }

  Item {
    width: root.width
    height: doneButton.implicitHeight
    Button {
      id: doneButton
      anchors.right: parent.right
      selected: true
      text: "Done"
      onClicked: root.store.setPage("list")
    }
  }
}
