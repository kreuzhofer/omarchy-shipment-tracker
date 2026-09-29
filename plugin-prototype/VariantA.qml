// PROTOTYPE variant A: one dense list sorted by urgency (#9).
// Header: title, last updated, 7d/30d, refresh. Needs-login banner.
// Rows: status glyph | title + Delayed tag | Estimate; second line Status ·
// Direction · Source/account/Carrier · age. Footer: manual add + notifications.
import QtQuick
import qs.Commons
import qs.Ui
import "FakeData.js" as Fake

Column {
  id: root
  property var host: null
  readonly property bool editing: addField.activeFocus
  readonly property color fg: host ? host.fg : Color.foreground
  readonly property string ff: host ? host.fontFamily : Style.font.family
  readonly property int rowHeight: Style.space(46)
  function scrollToEnd() { list.positionViewAtEnd() }
  // Borrowed from B: one-line summary in the header subtitle.
  function summary() {
    if (!host) return ""
    var need = host.shipments.filter(function(s) { return Fake.attention[s.status] }).length + host.troubled.length
    var today = host.shipments.filter(function(s) { return s.status === "Out for delivery" }).length
    return (need ? need + " need you · " : "") + (today ? today + " arriving today · " : "")
  }
  spacing: Style.space(8)

  // ---- Header
  Item {
    width: parent.width
    height: Math.max(titleCol.implicitHeight, headerButtons.implicitHeight)
    Column {
      id: titleCol
      anchors.left: parent.left
      width: parent.width - headerButtons.width - Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      Text { text: "Shipments"; color: root.fg; font.family: root.ff; font.pixelSize: Style.font.heading; font.bold: true }
      Text {
        width: parent.width
        elide: Text.ElideRight
        text: root.summary() + (root.host ? (root.host.refreshing ? "Refreshing…" : "Updated " + Fake.age(root.host.lastRefresh)) : "")
        color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.caption
      }
    }
    Row {
      id: headerButtons
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(4)
      Button { text: "7 days"; selected: root.host && root.host.days === 7; fontSize: Style.font.bodySmall; onClicked: root.host.days = 7 }
      Button { text: "30 days"; selected: root.host && root.host.days === 30; fontSize: Style.font.bodySmall; onClicked: root.host.days = 30 }
      PanelActionButton {
        iconText: "\u{F0450}"
        tooltipText: "Refresh now"
        foreground: root.fg
        onClicked: root.host.refresh()
      }
    }
  }

  // ---- needs-login / source-down banner
  Repeater {
    model: root.host ? root.host.troubled : []
    delegate: Rectangle {
      required property var modelData
      width: root.width
      height: bannerRow.implicitHeight + Style.space(12)
      radius: Style.cornerRadius
      color: Qt.rgba(Color.urgent.r, Color.urgent.g, Color.urgent.b, 0.18)
      border.color: Color.urgent
      border.width: 1
      Row {
        id: bannerRow
        anchors.left: parent.left
        anchors.leftMargin: Style.space(10)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(8)
        Text { text: "\u{F033E}"; color: Color.urgent; font.family: root.ff; font.pixelSize: Style.font.icon; anchors.verticalCenter: parent.verticalCenter }
        Text {
          width: root.width - Style.space(120)
          elide: Text.ElideRight
          text: modelData.source + (modelData.account ? " · " + modelData.account : "") + " needs a login · list may be incomplete"
          color: root.fg; font.family: root.ff; font.pixelSize: Style.font.bodySmall
          anchors.verticalCenter: parent.verticalCenter
        }
      }
      Button {
        anchors.right: parent.right
        anchors.rightMargin: Style.space(6)
        anchors.verticalCenter: parent.verticalCenter
        text: "Log in"; bordered: true; fontSize: Style.font.bodySmall
        onClicked: root.host.openUrl(modelData.loginUrl)
      }
    }
  }

  // ---- The list: 5 rows visible, scrolls to more.
  ListView {
    id: list
    width: parent.width
    height: Math.min(count, 5) * root.rowHeight
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    model: root.host ? root.host.shipments : []

    delegate: Rectangle {
      id: row
      required property var modelData
      required property int index
      readonly property var s: modelData
      readonly property bool isTerminal: Fake.terminal[s.status] === true
      readonly property bool pickup: s.status === "Ready for pickup"
      readonly property bool problem: s.status === "Problem"
      width: list.width
      height: root.rowHeight
      radius: Style.cornerRadius
      color: rowMouse.containsMouse ? Style.hoverFillFor(root.fg, Color.accent)
        : pickup ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.16)
        : "transparent"
      opacity: isTerminal ? 0.55 : 1

      Rectangle { // left rail marks the Shipments that need the user
        visible: row.pickup || row.problem
        width: Style.space(3); height: parent.height - Style.space(8)
        anchors.verticalCenter: parent.verticalCenter
        color: row.problem ? Color.urgent : Color.accent
      }

      Text {
        id: glyph
        anchors.left: parent.left
        anchors.leftMargin: Style.space(10)
        anchors.verticalCenter: parent.verticalCenter
        width: Style.space(22)
        text: Fake.statusGlyph(row.s.status)
        color: row.problem ? Color.urgent : row.pickup ? Color.accent : root.fg
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
            width: Math.min(implicitWidth, parent.width - estimateText.implicitWidth - delayTag.width - Style.space(12))
            elide: Text.ElideRight
            text: row.s.title
            color: root.fg; font.family: root.ff; font.pixelSize: Style.font.body; font.bold: row.pickup || row.problem
          }
          Rectangle {
            id: delayTag
            visible: row.s.delayed
            width: visible ? delayText.implicitWidth + Style.space(8) : 0
            height: delayText.implicitHeight + Style.space(2)
            anchors.left: titleText.right; anchors.leftMargin: Style.space(6)
            anchors.verticalCenter: titleText.verticalCenter
            radius: Style.cornerRadius
            color: Qt.rgba(Color.urgent.r, Color.urgent.g, Color.urgent.b, 0.25)
            Text { id: delayText; anchors.centerIn: parent; text: "Delayed"; color: root.fg; font.family: root.ff; font.pixelSize: Style.font.caption }
          }
          Text {
            id: estimateText
            anchors.right: parent.right
            text: row.s.estimate
            color: row.pickup ? Color.accent : root.fg; font.family: root.ff; font.pixelSize: Style.font.bodySmall; font.bold: row.pickup
          }
        }
        Text {
          width: parent.width
          elide: Text.ElideRight
          text: row.s.status + "  ·  " + (row.s.direction === "Outgoing" ? "\u{F005D} Outgoing" : "\u{F0045} Incoming") + "  ·  " + Fake.sourceLabel(row.s) + "  ·  " + Fake.age(row.s.changed)
          color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.caption
        }
      }

      MouseArea {
        id: rowMouse
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: root.host.openUrl(row.s.url)
      }
    }
  }

  // Empty state. A troubled Source keeps its banner above, so "no Shipments"
  // never hides a lost login (DHL returns an empty list on a lost session).
  Column {
    visible: list.count === 0
    width: parent.width
    spacing: Style.space(6)
    topPadding: Style.space(10)
    bottomPadding: Style.space(6)
    Text { anchors.horizontalCenter: parent.horizontalCenter; text: "\u{F03D7}"; color: Qt.darker(root.fg, 1.8); font.family: root.ff; font.pixelSize: Style.font.display }
    Text {
      anchors.horizontalCenter: parent.horizontalCenter
      text: "No Shipments in the last " + (root.host ? root.host.days : 7) + " days"
      color: Qt.darker(root.fg, 1.3); font.family: root.ff; font.pixelSize: Style.font.body
    }
    Button {
      anchors.horizontalCenter: parent.horizontalCenter
      visible: root.host && root.host.days === 7
      text: "Show 30 days"; bordered: true; fontSize: Style.font.bodySmall
      onClicked: root.host.days = 30
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

  // ---- Footer: manual add + notifications toggle
  Row {
    width: parent.width
    spacing: Style.space(6)
    TextField {
      id: addField
      width: parent.width - addButton.width - bell.width - Style.space(12)
      placeholderText: "Add tracking number or Amazon order ID"
      foreground: root.fg
      font.family: root.ff
      font.pixelSize: Style.font.bodySmall
      onAccepted: { if (root.host.addManual(text)) text = "" }
      Keys.onEscapePressed: focus = false
    }
    Button { id: addButton; text: "Add"; bordered: true; onClicked: { if (root.host.addManual(addField.text)) addField.text = "" } }
    PanelActionButton {
      id: bell
      anchors.verticalCenter: parent.verticalCenter
      iconText: root.host && root.host.notificationsOn ? "\u{F009A}" : "\u{F009B}"
      tooltipText: root.host && root.host.notificationsOn ? "Notifications on" : "Notifications off"
      foreground: root.fg
      onClicked: root.host.toggleNotifications()
    }
  }
}
