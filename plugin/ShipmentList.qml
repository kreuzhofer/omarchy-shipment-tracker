// The list page of the popup (layout from the #9 prototype, variant A):
// header with refresh, one row per Shipment, footer with the manual-add field.
// Row: Status glyph | title | Estimate; muted line Status · Direction · Source · age.
import QtQuick
import qs.Commons
import qs.Ui
import "Shipments.js" as Shipments

Column {
  id: root
  property var store: null
  property color fg: Color.foreground
  property string ff: Style.font.family
  // While the add field has focus the panel's list shortcuts are off.
  readonly property bool editing: addField.activeFocus
  readonly property int rowHeight: Style.space(46)
  signal openRequested(string url)
  signal closeRequested()
  spacing: Style.space(8)

  // ---- Header
  Item {
    width: parent.width
    height: Math.max(titleColumn.implicitHeight, refreshButton.implicitHeight)
    Column {
      id: titleColumn
      anchors.left: parent.left
      anchors.right: refreshButton.left
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      Text { text: "Shipments"; color: root.fg; font.family: root.ff; font.pixelSize: Style.font.heading; font.bold: true }
      Text {
        width: parent.width
        elide: Text.ElideRight
        text: !root.store ? "" : root.store.lastRun === "" ? "Not refreshed yet"
          : (root.store.sourcesState.offline ? "Offline · updated " : "Updated ") + Shipments.age(root.store.lastRun, root.store.nowMs)
        color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.caption
      }
    }
    PanelActionButton {
      id: refreshButton
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      iconText: "\u{F0450}"
      tooltipText: "Refresh now"
      foreground: root.fg
      onClicked: root.store.refresh()
    }
  }

  // ---- The list: 5 rows visible, scrolls to more.
  ListView {
    id: list
    width: parent.width
    height: Math.min(count, 5) * root.rowHeight
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    model: root.store ? root.store.shipments : []

    delegate: Rectangle {
      id: row
      required property var modelData
      readonly property var s: modelData
      readonly property bool isTerminal: s.status === "Delivered" || s.status === "Returned"
      width: list.width
      height: root.rowHeight
      radius: Style.cornerRadius
      color: rowMouse.containsMouse ? Style.hoverFillFor(root.fg, Color.accent) : "transparent"
      opacity: isTerminal ? 0.55 : 1

      Text {
        id: glyph
        anchors.left: parent.left
        anchors.leftMargin: Style.space(10)
        anchors.verticalCenter: parent.verticalCenter
        width: Style.space(22)
        text: Shipments.statusGlyph(row.s.status)
        color: root.fg
        font.family: root.ff; font.pixelSize: Style.font.iconLarge
      }

      Column {
        anchors.left: glyph.right
        anchors.leftMargin: Style.space(8)
        anchors.right: parent.right
        anchors.rightMargin: Style.space(10)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(2)

        Item {
          width: parent.width
          height: titleText.implicitHeight
          Text {
            id: titleText
            anchors.left: parent.left
            width: Math.min(implicitWidth, parent.width - estimateText.implicitWidth - Style.space(12))
            elide: Text.ElideRight
            text: row.s.title
            color: root.fg; font.family: root.ff; font.pixelSize: Style.font.body
          }
          Text {
            id: estimateText
            anchors.right: parent.right
            text: row.s.estimate ? row.s.estimate.text : ""
            color: root.fg; font.family: root.ff; font.pixelSize: Style.font.bodySmall
          }
        }
        Text {
          width: parent.width
          elide: Text.ElideRight
          text: row.s.status + "  ·  " + (row.s.direction === "Outgoing" ? "\u{F005D} Outgoing" : "\u{F0045} Incoming")
            + "  ·  " + Shipments.sourceLabel(row.s) + "  ·  " + Shipments.age(row.s.changedAt, root.store.nowMs)
          color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.caption
        }
      }

      MouseArea {
        id: rowMouse
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: root.openRequested(row.s.url)
      }
    }
  }

  // ---- Empty state
  Column {
    visible: list.count === 0
    width: parent.width
    spacing: Style.space(6)
    topPadding: Style.space(10)
    bottomPadding: Style.space(6)
    Text { anchors.horizontalCenter: parent.horizontalCenter; text: "\u{F03D7}"; color: Qt.darker(root.fg, 1.8); font.family: root.ff; font.pixelSize: Style.font.display }
    Text {
      anchors.horizontalCenter: parent.horizontalCenter
      text: "No Shipments yet"
      color: Qt.darker(root.fg, 1.3); font.family: root.ff; font.pixelSize: Style.font.body
    }
    Text {
      width: parent.width - Style.space(40)
      anchors.horizontalCenter: parent.horizontalCenter
      horizontalAlignment: Text.AlignHCenter
      wrapMode: Text.WordWrap
      text: "Paste a DHL tracking number below to track it."
      color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.bodySmall
    }
  }

  Text {
    width: parent.width
    horizontalAlignment: Text.AlignHCenter
    visible: list.count > 5
    text: list.count + " Shipments · scroll for more"
    color: Qt.darker(root.fg, 1.6); font.family: root.ff; font.pixelSize: Style.font.caption
  }

  PanelSeparator { foreground: root.fg }

  // ---- Footer: manual add
  Row {
    width: parent.width
    spacing: Style.space(6)
    TextField {
      id: addField
      width: parent.width - addButton.width - Style.space(6)
      placeholderText: "Add tracking number"
      foreground: root.fg
      font.family: root.ff
      font.pixelSize: Style.font.bodySmall
      onAccepted: { if (root.store.add(text)) text = "" }
      Keys.onEscapePressed: root.closeRequested()
    }
    Button {
      id: addButton
      text: "Add"
      bordered: true
      onClicked: { if (root.store.add(addField.text)) addField.text = "" }
    }
  }

  Text {
    visible: root.store && root.store.addError !== ""
    width: parent.width
    wrapMode: Text.WordWrap
    text: root.store ? root.store.addError : ""
    color: Color.urgent; font.family: root.ff; font.pixelSize: Style.font.caption
  }
}
