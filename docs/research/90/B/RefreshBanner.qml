// #90 variant B: above the list while background refresh is off, until it is
// turned on or dismissed (dismissal would be remembered in the state dir).
// Same shape as the Login progress banner, muted instead of accent.
import QtQuick
import qs.Commons
import qs.Ui

Rectangle {
  id: root
  property var store: null
  property color fg: Color.foreground
  property string ff: Style.font.family
  property bool dismissed: false

  visible: !!store && store.timerInstalled === false && !dismissed
  height: visible ? Math.max(text.implicitHeight, buttons.implicitHeight) + Style.space(12) : 0
  radius: Style.cornerRadius
  color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.10)
  border.color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.6)
  border.width: 1

  Text {
    id: glyph
    anchors.left: parent.left
    anchors.leftMargin: Style.space(10)
    anchors.verticalCenter: parent.verticalCenter
    text: "\u{F04E8}" // sync-off
    color: Color.accent; font.family: root.ff; font.pixelSize: Style.font.icon
  }
  Text {
    id: text
    anchors.left: glyph.right
    anchors.leftMargin: Style.space(8)
    anchors.right: buttons.left
    anchors.rightMargin: Style.space(8)
    anchors.verticalCenter: parent.verticalCenter
    wrapMode: Text.WordWrap
    text: "Background refresh is off. Turn on adds two systemd user timers that refresh hourly."
    color: root.fg; font.family: root.ff; font.pixelSize: Style.font.bodySmall
  }
  Row {
    id: buttons
    anchors.right: parent.right
    anchors.rightMargin: Style.space(4)
    anchors.verticalCenter: parent.verticalCenter
    spacing: Style.space(2)
    Button {
      anchors.verticalCenter: parent.verticalCenter
      enabled: !!root.store && !root.store.timerBusy && root.store.nodeOk !== false
      text: "Turn on"
      bordered: true; fontSize: Style.font.bodySmall
      onClicked: root.store.installTimer()
    }
    PanelActionButton {
      anchors.verticalCenter: parent.verticalCenter
      iconText: "\u{F0156}" // close
      tooltipText: "Not now"
      foreground: root.fg
      onClicked: root.dismissed = true
    }
  }
}
