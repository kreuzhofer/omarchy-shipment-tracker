// The Microsoft 365 mail row's setup (#18 §5). Mail arrives with #34, which
// replaces the placeholder below with Connect mail, the device code (Copy
// code, Open page, Cancel) and the Connection's state, and sets
// Store.mailAvailable so the row opens by itself when it's the first one not
// set up.
import QtQuick
import qs.Commons
import qs.Ui

Column {
  id: root
  property var store: null
  property color fg: Color.foreground
  property string ff: Style.font.family
  spacing: Style.space(8)

  Text {
    width: root.width
    wrapMode: Text.WordWrap
    text: "Optional. Reads delivery mails in your Microsoft 365 mailbox, read-only, to catch Amazon Orders from accounts not connected above. Signs in through the ms-365-mcp-server with a device code."
    color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.bodySmall
  }

  // Placeholder until #34.
  Row {
    spacing: Style.space(8)
    Button {
      anchors.verticalCenter: parent.verticalCenter
      enabled: false
      opacity: 0.45
      selected: true; text: "Connect mail"; fontSize: Style.font.bodySmall
    }
    Text {
      anchors.verticalCenter: parent.verticalCenter
      text: "Not available yet"
      color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.caption
    }
  }
}
