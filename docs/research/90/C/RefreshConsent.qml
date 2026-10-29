// #90 variant C: asked once, in the row of the first Connection whose Login
// just finished (here: DHL). Turn on runs `install`; Not now leaves it off and
// is remembered in the state dir, so it doesn't ask again. The Sources page
// footer keeps Turn on / Turn off for later.
import QtQuick
import qs.Commons
import qs.Ui

Rectangle {
  id: root
  property var store: null
  property color fg: Color.foreground
  property string ff: Style.font.family
  property string connectionKey: ""
  property string name: ""
  property bool answered: false
  readonly property var connection: store ? store.connection(connectionKey) : null
  // Within 10 min of a successful Login, while the timers aren't there.
  // `loggedInAt` is hypothetical (the CLI would set it when a Login ends ok).
  readonly property bool justConnected: !!connection && !!connection.loggedInAt && connection.health === "ok"
    && !!store && store.nowMs - new Date(connection.loggedInAt).getTime() < 10 * 60000

  visible: !!store && store.timerInstalled === false && justConnected && !answered
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
      spacing: Style.space(8)
      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: "\u{F04E6}" // sync
        color: Color.accent; font.family: root.ff; font.pixelSize: Style.font.icon
      }
      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: root.name + " is connected. Keep it up to date in the background?"
        color: root.fg; font.family: root.ff; font.pixelSize: Style.font.bodySmall
      }
    }
    Text {
      width: column.width
      wrapMode: Text.WordWrap
      text: "This adds two systemd user timers to ~/.config/systemd/user: hourly, and every 15 min while a parcel is due. Without them, Shipments refresh when you open this popup."
      color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.caption
    }
    Row {
      spacing: Style.space(6)
      Button {
        selected: true
        enabled: !!root.store && !root.store.timerBusy && root.store.nodeOk !== false
        text: "Turn on background refresh"; fontSize: Style.font.bodySmall
        onClicked: root.store.installTimer()
      }
      Button {
        bordered: true; text: "Not now"; fontSize: Style.font.bodySmall
        onClicked: root.answered = true
      }
    }
  }
}
