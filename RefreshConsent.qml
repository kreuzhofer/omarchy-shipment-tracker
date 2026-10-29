// Background refresh is opt-in (#90): after the first successful Login of a
// Connection, its Sources row asks once whether to install the systemd user
// timers. Turn on runs `install`; Not now runs `uninstall`, which only
// records "off". Either answer is stored as `backgroundRefresh` in
// sources.json, so it never asks again; the page footer keeps Turn on / off.
// Shown where Store.consentKey says (the latest Login), for that Connection.
import QtQuick
import qs.Commons
import qs.Ui
import "Shipments.js" as Shipments

Rectangle {
  id: root
  property var store: null
  property color fg: Color.foreground
  property string ff: Style.font.family
  property string connectionKey: ""
  readonly property var connection: store && connectionKey !== "" ? store.connection(connectionKey) : null

  visible: !!store && connectionKey !== "" && store.consentKey === connectionKey
  height: visible ? column.implicitHeight + Style.space(20) : 0
  radius: Style.cornerRadius
  color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.12)
  border.color: Color.accent
  border.width: 1

  Column {
    id: column
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: parent.top
    anchors.margins: Style.space(10)
    spacing: Style.space(6)
    Row {
      width: column.width
      spacing: Style.space(8)
      Text {
        id: glyph
        text: "\u{F04E6}" // sync
        color: Color.accent; font.family: root.ff; font.pixelSize: Style.font.icon
      }
      Text {
        anchors.verticalCenter: glyph.verticalCenter
        width: column.width - glyph.width - parent.spacing
        wrapMode: Text.WordWrap
        text: Shipments.connectionName(root.connectionKey, root.connection) + " is connected. Keep it up to date in the background?"
        color: root.fg; font.family: root.ff; font.pixelSize: Style.font.bodySmall
      }
    }
    Text {
      width: column.width
      wrapMode: Text.WordWrap
      text: "This adds two systemd user timers to ~/.config/systemd/user: hourly, and every 15 min while a DHL parcel is due. Without them, Shipments refresh when you open this popup."
      color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.caption
    }
    Row {
      spacing: Style.space(6)
      readonly property bool canAnswer: !!root.store && !root.store.timerBusy && root.store.nodeOk !== false
      Button {
        enabled: parent.canAnswer
        opacity: enabled ? 1 : 0.45
        selected: true
        text: "Turn on background refresh"; fontSize: Style.font.bodySmall
        onClicked: root.store.installTimer()
      }
      Button {
        enabled: parent.canAnswer
        opacity: enabled ? 1 : 0.45
        bordered: true; text: "Not now"; fontSize: Style.font.bodySmall
        onClicked: root.store.uninstallTimer()
      }
    }
  }
}
