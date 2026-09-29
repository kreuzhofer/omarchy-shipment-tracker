// Node.js is missing, so the shipment-tracker CLI can't run (#18 §6): shown
// on every Sources row and next to the add field, with "Install Node.js"
// (`omarchy pkg add nodejs npm` in Omarchy's floating terminal).
import QtQuick
import qs.Commons
import qs.Ui

Rectangle {
  id: root
  property var store: null
  property color fg: Color.foreground
  property string ff: Style.font.family
  property string text: "Connecting Sources needs Node.js, which isn't installed."

  visible: !!store && store.nodeOk === false
  height: visible ? Math.max(noticeText.implicitHeight, installButton.implicitHeight) + Style.space(14) : 0
  radius: Style.cornerRadius
  color: Qt.rgba(Color.urgent.r, Color.urgent.g, Color.urgent.b, 0.12)
  border.color: Color.urgent
  border.width: 1

  Text {
    id: noticeText
    anchors.left: parent.left
    anchors.leftMargin: Style.space(10)
    anchors.right: installButton.left
    anchors.rightMargin: Style.space(10)
    anchors.verticalCenter: parent.verticalCenter
    wrapMode: Text.WordWrap
    text: root.text
    color: root.fg; font.family: root.ff; font.pixelSize: Style.font.bodySmall
  }
  Button {
    id: installButton
    anchors.right: parent.right
    anchors.rightMargin: Style.space(10)
    anchors.verticalCenter: parent.verticalCenter
    enabled: !(root.store && root.store.nodeInstalling)
    text: root.store && root.store.nodeInstalling ? "Installing…" : "Install Node.js"
    bordered: true; fontSize: Style.font.bodySmall
    onClicked: root.store.installNode()
  }
}
