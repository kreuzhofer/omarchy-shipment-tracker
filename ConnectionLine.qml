// A Connection's state on the Sources page: glyph and one line. While its
// Login runs, the Login's progress; otherwise its Health, and after a Login
// that didn't succeed, "Login cancelled" etc. (also when not set up or ok).
import QtQuick
import qs.Commons
import "Shipments.js" as Shipments

Row {
  id: root
  property var store: null
  property color fg: Color.foreground
  property string ff: Style.font.family
  property string connectionKey: ""
  readonly property var connection: store ? store.connection(connectionKey) : null
  readonly property bool loggingIn: !!store && !!store.activeLogin && store.activeLogin.key === connectionKey
  readonly property string tone: Shipments.connectionTone(connection, loggingIn)
  readonly property string line: !store ? ""
    : loggingIn ? Shipments.rowLoginText(connectionKey, store.activeLogin.connection, store.nowMs)
    : Shipments.rowHealthText(connectionKey, connection, store.nowMs)

  visible: line !== ""
  spacing: Style.space(8)

  Text {
    id: lineGlyph
    text: Shipments.connectionGlyph(root.connection, root.loggingIn)
    color: root.tone === "bad" ? Color.urgent : root.tone === "good" || root.tone === "busy" ? Color.accent : root.fg
    font.family: root.ff; font.pixelSize: Style.font.icon
  }
  Text {
    anchors.verticalCenter: parent.verticalCenter
    width: root.width - lineGlyph.width - root.spacing
    wrapMode: Text.WordWrap
    text: root.line
    color: root.fg; font.family: root.ff; font.pixelSize: Style.font.bodySmall
  }
}
