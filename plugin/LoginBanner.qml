// The Login progress banner (#18 §7, layout from the prototype/onboarding
// banners): accent tone above the list while a Login runs, with the 15-minute
// countdown and Cancel. It replaces the Connection's needs-login banner until
// the Login ends; Cancel is gone once the first sync runs.
import QtQuick
import qs.Commons
import qs.Ui
import "Shipments.js" as Shipments

Rectangle {
  id: root
  property var store: null
  property color fg: Color.foreground
  property string ff: Style.font.family
  readonly property var active: store ? store.activeLogin : null
  readonly property var login: active && active.connection ? active.connection.login : null
  readonly property string phase: login ? login.phase : "starting"

  visible: !!active
  height: visible ? Math.max(text.implicitHeight, cancelButton.implicitHeight) + Style.space(12) : 0
  radius: Style.cornerRadius
  color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.14)
  border.color: Color.accent
  border.width: 1

  Text {
    id: glyph
    anchors.left: parent.left
    anchors.leftMargin: Style.space(10)
    anchors.verticalCenter: parent.verticalCenter
    text: root.phase === "syncing" ? "\u{F04E6}" : root.phase === "waiting" ? "\u{F0150}" : "\u{F059F}" // sync / clock / web
    color: Color.accent; font.family: root.ff; font.pixelSize: Style.font.icon
  }
  Text {
    id: text
    anchors.left: glyph.right
    anchors.leftMargin: Style.space(8)
    anchors.right: cancelButton.visible ? cancelButton.left : parent.right
    anchors.rightMargin: Style.space(8)
    anchors.verticalCenter: parent.verticalCenter
    wrapMode: Text.WordWrap
    maximumLineCount: 2
    elide: Text.ElideRight
    text: root.active ? Shipments.loginText(root.active.key, root.active.connection, root.store.nowMs) : ""
    color: root.fg; font.family: root.ff; font.pixelSize: Style.font.bodySmall
  }
  Button {
    id: cancelButton
    visible: root.phase !== "syncing"
    anchors.right: parent.right
    anchors.rightMargin: Style.space(6)
    anchors.verticalCenter: parent.verticalCenter
    text: "Cancel"
    bordered: true; fontSize: Style.font.bodySmall
    onClicked: root.store.cancelLogin()
  }
}
