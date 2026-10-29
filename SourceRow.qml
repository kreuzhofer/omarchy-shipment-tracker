// One accordion row of the Sources page (#18 variant B): glyph, name and
// what it is on the left, the state summary and a chevron on the right.
// Clicking the header opens it (and closes the others); its setup (the
// children) shows only while open.
import QtQuick
import qs.Commons
import qs.Ui

Rectangle {
  id: root
  property var store: null
  property color fg: Color.foreground
  property string ff: Style.font.family
  // dhl | amazon | mail, as in the IPC `page sources:<row>`.
  property string row: ""
  property string glyph: ""
  property string name: ""
  property string subtitle: ""
  property string summary: ""
  // "bad" (needs the user), "good" (connected) or "" (muted).
  property string tone: ""
  readonly property bool open: !!store && store.openRow === row
  default property alias content: body.data

  height: column.implicitHeight + Style.space(12)
  radius: Style.cornerRadius
  color: open ? Style.normalFillFor(fg, Color.accent, Color.urgent) : "transparent"
  border.color: open ? Qt.rgba(fg.r, fg.g, fg.b, 0.2) : "transparent"
  border.width: 1

  Column {
    id: column
    x: Style.space(8)
    y: Style.space(6)
    width: parent.width - Style.space(16)
    spacing: Style.space(8)

    Item {
      width: parent.width
      height: Style.space(34)
      Text {
        id: rowGlyph
        anchors.verticalCenter: parent.verticalCenter
        width: Style.space(24)
        text: root.glyph
        color: root.fg; font.family: root.ff; font.pixelSize: Style.font.iconLarge
      }
      Column {
        anchors.left: rowGlyph.right
        anchors.leftMargin: Style.space(8)
        anchors.right: summaryRow.left
        anchors.rightMargin: Style.space(8)
        anchors.verticalCenter: parent.verticalCenter
        Text { text: root.name; color: root.fg; font.family: root.ff; font.pixelSize: Style.font.body; font.bold: true }
        Text { width: parent.width; elide: Text.ElideRight; text: root.subtitle; color: Qt.darker(root.fg, 1.6); font.family: root.ff; font.pixelSize: Style.font.caption }
      }
      Row {
        id: summaryRow
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(6)
        Text {
          anchors.verticalCenter: parent.verticalCenter
          text: root.summary
          color: root.tone === "bad" ? Color.urgent : root.tone === "good" ? Color.accent : Qt.darker(root.fg, 1.5)
          font.family: root.ff; font.pixelSize: Style.font.bodySmall
        }
        Text {
          anchors.verticalCenter: parent.verticalCenter
          text: root.open ? "\u{F0140}" : "\u{F0142}" // chevron down / right
          color: Qt.darker(root.fg, 1.4); font.family: root.ff; font.pixelSize: Style.font.icon
        }
      }
      MouseArea {
        anchors.fill: parent
        cursorShape: Qt.PointingHandCursor
        onClicked: root.store.toggleRow(root.row)
      }
    }

    Column {
      id: body
      visible: root.open
      width: parent.width
      spacing: Style.space(8)
    }
  }
}
